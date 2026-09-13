terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region  = "us-east-2"
  profile = "terraform"
}

# No-op verification: proves auth + provider wiring work without creating anything.
data "aws_caller_identity" "current" {}

output "verified_account_id" {
  value = data.aws_caller_identity.current.account_id
}

output "verified_arn" {
  value = data.aws_caller_identity.current.arn
}

# Calls the real Bedrock ListFoundationModels API. If Bedrock were actually
# suspended on this account, this data source would fail to read.
data "aws_bedrock_foundation_models" "test" {
  by_provider = "anthropic"
}

output "bedrock_access_check" {
  value = "Bedrock reachable - ${length(data.aws_bedrock_foundation_models.test.model_summaries)} Anthropic models visible"
}
