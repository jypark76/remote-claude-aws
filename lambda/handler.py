"""
Lambda function behind these routes:
  POST   /chat              - talk to Claude, save the chat
  POST   /upload-url        - get a temporary link to upload a file straight to S3
  GET    /chats             - list every saved chat
  GET    /chats/{chat_id}   - full history for one chat
  PATCH  /chats/{chat_id}   - rename a chat
  DELETE /chats/{chat_id}   - delete a chat

Not currently deployed - the API Gateway/Cognito stack that fronted this was
torn down as unused (see infra git history). Kept hardened anyway rather
than left as dead-but-broken code, since redeploying it later without
re-noticing these gaps would be an easy mistake to make.
"""
import json
import os
import time
import uuid
import urllib.request
import boto3

API_KEY = os.environ["ANTHROPIC_API_KEY"]
API_URL = "https://api.anthropic.com/v1/messages"
TABLE_NAME = os.environ["DYNAMODB_TABLE"]
BUCKET_NAME = os.environ["S3_BUCKET"]

table = boto3.resource("dynamodb").Table(TABLE_NAME)
_region = os.environ["AWS_REGION"]
s3 = boto3.client("s3", region_name=_region, endpoint_url=f"https://s3.{_region}.amazonaws.com")


def call_claude(messages):
    payload = json.dumps({
        "model": "claude-sonnet-5",
        "max_tokens": 1024,
        "messages": messages,
    }).encode()

    req = urllib.request.Request(
        API_URL,
        data=payload,
        headers={
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())

    return "".join(
        block["text"] for block in result.get("content", []) if block.get("type") == "text"
    )


def username_from_event(event):
    """The caller's identity, from the JWT the API Gateway authorizer already
    verified (event.requestContext.authorizer.jwt.claims). Returns None if
    there's no verified identity at all - callers must treat that as
    unauthenticated and refuse the request, not fall back to trusting
    anything the request body itself claims about who's asking."""
    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )
    return claims.get("cognito:username") or claims.get("username")


def safe_filename(name):
    """Strips any directory component and rejects traversal-shaped names, the
    same posture as the EC2 app's upload route - a filename is attacker-
    controlled input, and using it directly to build an S3 key would let
    '../../whatever' write outside the intended chat_id/ prefix."""
    name = os.path.basename(name or "")
    if not name or name in (".", ".."):
        return None
    return name


def handle_chat(username, body):
    user_message = body.get("message", "")
    chat_id = body.get("chat_id")

    item = table.get_item(Key={"chat_id": chat_id}).get("Item") if chat_id else None
    if item and item.get("owner") != username and username != "admin":
        return {"error": "not found"}, 404
    history = item["messages"] if item else []
    if not chat_id:
        chat_id = str(uuid.uuid4())

    history.append({"role": "user", "content": user_message})
    reply_text = call_claude(history)
    history.append({"role": "assistant", "content": reply_text})

    table.put_item(Item={
        "chat_id": chat_id,
        "owner": item["owner"] if item else username,
        "title": item["title"] if item else user_message[:40],
        "messages": history,
        "updated_at": int(time.time()),
    })

    return {"chat_id": chat_id, "reply": reply_text}, 200


def handle_upload_url(username, body):
    chat_id = body.get("chat_id") or str(uuid.uuid4())
    filename = safe_filename(body.get("filename"))
    if not filename:
        return {"error": f"rejected: unsafe filename {body.get('filename')!r}"}, 400
    content_type = body.get("content_type") or "application/octet-stream"
    key = f"{chat_id}/{filename}"

    upload_url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": BUCKET_NAME, "Key": key, "ContentType": content_type},
        ExpiresIn=300,  # link only works for 5 minutes
    )
    return {"chat_id": chat_id, "upload_url": upload_url, "key": key}, 200


def handle_get_chat(username, chat_id):
    item = table.get_item(Key={"chat_id": chat_id}).get("Item")
    if not item or (item.get("owner") != username and username != "admin"):
        return {"error": "not found"}, 404
    return {"chat_id": item["chat_id"], "title": item["title"], "messages": item["messages"]}, 200


def handle_rename_chat(username, chat_id, body):
    item = table.get_item(Key={"chat_id": chat_id}).get("Item")
    if not item or (item.get("owner") != username and username != "admin"):
        return {"error": "not found"}, 404
    new_title = body["title"]
    table.update_item(
        Key={"chat_id": chat_id},
        UpdateExpression="SET title = :t",
        ExpressionAttributeValues={":t": new_title},
    )
    return {"ok": True}, 200


def handle_delete_chat(username, chat_id):
    item = table.get_item(Key={"chat_id": chat_id}).get("Item")
    if not item or (item.get("owner") != username and username != "admin"):
        return {"error": "not found"}, 404
    table.delete_item(Key={"chat_id": chat_id})
    return {"ok": True}, 200


def handle_list_chats(username):
    items = table.scan().get("Items", [])
    chats = [
        {"chat_id": i["chat_id"], "title": i["title"], "updated_at": int(i["updated_at"])}
        for i in items
        if i.get("owner") == username or username == "admin"
    ]
    chats.sort(key=lambda c: c["updated_at"], reverse=True)
    return {"chats": chats}, 200


def lambda_handler(event, context):
    username = username_from_event(event)
    if not username:
        return {"statusCode": 401, "body": json.dumps({"error": "missing or invalid login token"})}

    route = event.get("routeKey", "")

    if route == "GET /chats":
        result, status = handle_list_chats(username)
    elif route == "GET /chats/{chat_id}":
        result, status = handle_get_chat(username, event["pathParameters"]["chat_id"])
    elif route == "DELETE /chats/{chat_id}":
        result, status = handle_delete_chat(username, event["pathParameters"]["chat_id"])
    elif route == "PATCH /chats/{chat_id}":
        result, status = handle_rename_chat(username, event["pathParameters"]["chat_id"], json.loads(event.get("body") or "{}"))
    else:
        body = json.loads(event.get("body") or "{}")
        if route == "POST /upload-url":
            result, status = handle_upload_url(username, body)
        else:
            result, status = handle_chat(username, body)

    return {"statusCode": status, "body": json.dumps(result)}
