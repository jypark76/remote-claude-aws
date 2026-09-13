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
