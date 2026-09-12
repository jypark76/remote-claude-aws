# Zips up the Lambda code so Terraform can upload it
data "archive_file" "handler" {
  type        = "zip"
  source_file = "${path.module}/../lambda/handler.py"
  output_path = "${path.module}/../lambda/handler.zip"
}

# Lets Lambda run and write basic logs. Nothing else yet.
resource "aws_iam_role" "lambda_exec" {
  name = "remote-claude-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Lets Lambda read and write the chats table, nothing else
resource "aws_iam_role_policy" "lambda_dynamodb" {
  name = "remote-claude-lambda-dynamodb"
  role = aws_iam_role.lambda_exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
      Resource = aws_dynamodb_table.chats.arn
    }]
  })
}

# Lets Lambda hand out upload/download links for the files bucket
resource "aws_iam_role_policy" "lambda_s3" {
  name = "remote-claude-lambda-s3"
  role = aws_iam_role.lambda_exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject"]
      Resource = "${aws_s3_bucket.files.arn}/*"
    }]
  })
}

resource "aws_lambda_function" "chat" {
  function_name    = "remote-claude-chat"
  filename         = data.archive_file.handler.output_path
  source_code_hash = data.archive_file.handler.output_base64sha256
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  role             = aws_iam_role.lambda_exec.arn
  timeout          = 30

  environment {
    variables = {
      ANTHROPIC_API_KEY = var.anthropic_api_key
      DYNAMODB_TABLE    = aws_dynamodb_table.chats.name
      S3_BUCKET         = aws_s3_bucket.files.bucket
    }
  }
}
