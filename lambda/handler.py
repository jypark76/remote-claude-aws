"""
Lambda function behind these routes:
  POST   /chat              - talk to Claude, save the chat
  POST   /upload-url        - get a temporary link to upload a file straight to S3
  GET    /chats             - list every saved chat
  GET    /chats/{chat_id}   - full history for one chat
  PATCH  /chats/{chat_id}   - rename a chat
  DELETE /chats/{chat_id}   - delete a chat
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


def handle_chat(body):
    user_message = body.get("message", "")
    chat_id = body.get("chat_id")

    item = table.get_item(Key={"chat_id": chat_id}).get("Item") if chat_id else None
    history = item["messages"] if item else []
    if not chat_id:
        chat_id = str(uuid.uuid4())

    history.append({"role": "user", "content": user_message})
    reply_text = call_claude(history)
    history.append({"role": "assistant", "content": reply_text})

    table.put_item(Item={
        "chat_id": chat_id,
        "title": item["title"] if item else user_message[:40],
        "messages": history,
        "updated_at": int(time.time()),
    })

    return {"chat_id": chat_id, "reply": reply_text}


def handle_upload_url(body):
    chat_id = body.get("chat_id") or str(uuid.uuid4())
    filename = body["filename"]
    content_type = body.get("content_type") or "application/octet-stream"
    key = f"{chat_id}/{filename}"

    upload_url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": BUCKET_NAME, "Key": key, "ContentType": content_type},
        ExpiresIn=300,  # link only works for 5 minutes
    )
    return {"chat_id": chat_id, "upload_url": upload_url, "key": key}


def handle_get_chat(chat_id):
    item = table.get_item(Key={"chat_id": chat_id}).get("Item")
    if not item:
        return {"error": "not found"}
    return {"chat_id": item["chat_id"], "title": item["title"], "messages": item["messages"]}


def handle_rename_chat(chat_id, body):
    new_title = body["title"]
    table.update_item(
        Key={"chat_id": chat_id},
        UpdateExpression="SET title = :t",
        ExpressionAttributeValues={":t": new_title},
    )
    return {"ok": True}


def handle_delete_chat(chat_id):
    table.delete_item(Key={"chat_id": chat_id})
    return {"ok": True}


def handle_list_chats():
    items = table.scan().get("Items", [])
    chats = [
        {"chat_id": i["chat_id"], "title": i["title"], "updated_at": int(i["updated_at"])}
        for i in items
    ]
    chats.sort(key=lambda c: c["updated_at"], reverse=True)
    return {"chats": chats}


def lambda_handler(event, context):
    route = event.get("routeKey", "")

    if route == "GET /chats":
        result = handle_list_chats()
    elif route == "GET /chats/{chat_id}":
        result = handle_get_chat(event["pathParameters"]["chat_id"])
    elif route == "DELETE /chats/{chat_id}":
        result = handle_delete_chat(event["pathParameters"]["chat_id"])
    elif route == "PATCH /chats/{chat_id}":
        result = handle_rename_chat(event["pathParameters"]["chat_id"], json.loads(event.get("body") or "{}"))
    else:
        body = json.loads(event.get("body") or "{}")
        if route == "POST /upload-url":
            result = handle_upload_url(body)
        else:
            result = handle_chat(body)

    return {"statusCode": 200, "body": json.dumps(result)}
