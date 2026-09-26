# IN PLAIN ENGLISH: despite the folder name "terraform" (a tool for
# describing your cloud infrastructure as code), this file does NOT build
# or manage the real, live infrastructure at all - it only checks two
# things: "am I logged into the right AWS account?" and "can I actually
# reach Amazon Bedrock (the AI service) from this account?" The real
# servers, database, load balancer, etc. were set up some other way
# (outside this file) and aren't described in code anywhere in this repo.
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
# In plain English: just asks AWS "who am I logged in as right now?" -
# doesn't create or change anything.
data "aws_caller_identity" "current" {}

output "verified_account_id" {
  value = data.aws_caller_identity.current.account_id
}

output "verified_arn" {
  value = data.aws_caller_identity.current.arn
}

# Calls the real Bedrock ListFoundationModels API. If Bedrock were actually
# suspended on this account, this data source would fail to read.
# In plain English: double-checks that this AWS account is actually
# allowed to use Amazon Bedrock (the AI service the app was originally
# meant to use).
data "aws_bedrock_foundation_models" "test" {
  by_provider = "anthropic"
}

output "bedrock_access_check" {
  value = "Bedrock reachable - ${length(data.aws_bedrock_foundation_models.test.model_summaries)} Anthropic models visible"
}
