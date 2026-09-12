# Gives the Lambda a real public web address
resource "aws_apigatewayv2_api" "chat_api" {
  name          = "remote-claude-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"] # tighten to the real site once it has a domain
    allow_methods = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["content-type", "authorization"]
  }
}

resource "aws_apigatewayv2_integration" "chat_lambda" {
  api_id                 = aws_apigatewayv2_api.chat_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.chat.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "chat_route" {
  api_id             = aws_apigatewayv2_api.chat_api.id
  route_key          = "POST /chat"
  target             = "integrations/${aws_apigatewayv2_integration.chat_lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "upload_url_route" {
  api_id             = aws_apigatewayv2_api.chat_api.id
  route_key          = "POST /upload-url"
  target             = "integrations/${aws_apigatewayv2_integration.chat_lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "list_chats_route" {
  api_id             = aws_apigatewayv2_api.chat_api.id
  route_key          = "GET /chats"
  target             = "integrations/${aws_apigatewayv2_integration.chat_lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "get_chat_route" {
  api_id             = aws_apigatewayv2_api.chat_api.id
  route_key          = "GET /chats/{chat_id}"
  target             = "integrations/${aws_apigatewayv2_integration.chat_lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "delete_chat_route" {
  api_id             = aws_apigatewayv2_api.chat_api.id
  route_key          = "DELETE /chats/{chat_id}"
  target             = "integrations/${aws_apigatewayv2_integration.chat_lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "rename_chat_route" {
  api_id             = aws_apigatewayv2_api.chat_api.id
  route_key          = "PATCH /chats/{chat_id}"
  target             = "integrations/${aws_apigatewayv2_integration.chat_lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.chat_api.id
  name        = "$default"
  auto_deploy = true
}

# Lets API Gateway actually call the Lambda
resource "aws_lambda_permission" "allow_apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.chat.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.chat_api.execution_arn}/*/*"
}

output "api_url" {
  value = "${aws_apigatewayv2_api.chat_api.api_endpoint}/chat"
}
