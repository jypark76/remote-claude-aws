terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

provider "aws" {
  region = "us-west-1"
}

# Files: PDFs, images, anything uploaded or created
resource "aws_s3_bucket" "files" {
  bucket = "remote-claude-files-073770536287"
}

# Lets the browser upload straight to this bucket (tighten origin once there's a real domain)
resource "aws_s3_bucket_cors_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  cors_rule {
    allowed_origins = ["*"]
    allowed_methods = ["PUT"]
    allowed_headers = ["*"]
  }
}

# Chat history: one item per chat, messages stored inside it
resource "aws_dynamodb_table" "chats" {
  name         = "remote-claude-chats"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "chat_id"

  attribute {
    name = "chat_id"
    type = "S"
  }
}
