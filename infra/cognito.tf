# The login system. Just 2 accounts, no public sign-up.
resource "aws_cognito_user_pool" "users" {
  name = "remote-claude-users"

  admin_create_user_config {
    allow_admin_create_user_only = true # nobody can self sign-up
  }

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }
}

# Lets the React app talk to Cognito to log in
resource "aws_cognito_user_pool_client" "app_client" {
  name                                 = "remote-claude-client"
  user_pool_id                         = aws_cognito_user_pool.users.id
  explicit_auth_flows                  = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_USER_SRP_AUTH", "ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  generate_secret                      = false # browser apps can't keep a secret hidden
  access_token_validity                = 24
  id_token_validity                    = 24
  token_validity_units {
    access_token = "hours"
    id_token     = "hours"
  }
}

resource "aws_cognito_user" "admin" {
  user_pool_id   = aws_cognito_user_pool.users.id
  username       = "admin"
  password       = var.admin_password
  message_action = "SUPPRESS" # don't email an invite, just create it
}

resource "aws_cognito_user" "standard_user" {
  user_pool_id   = aws_cognito_user_pool.users.id
  username       = "cory"
  password       = var.user_password
  message_action = "SUPPRESS"
}

# Created but locked out until you're ready to use it
resource "null_resource" "disable_cory" {
  depends_on = [null_resource.make_passwords_permanent]

  provisioner "local-exec" {
    interpreter = ["PowerShell", "-Command"]
    command     = "& 'C:/Program Files/Amazon/AWSCLIV2/aws.exe' cognito-idp admin-disable-user --user-pool-id ${aws_cognito_user_pool.users.id} --username cory"
  }
}

# Cognito marks a set password as "temporary" until you log in once and
# change it. This flips both straight to permanent so they just work.
resource "null_resource" "make_passwords_permanent" {
  depends_on = [aws_cognito_user.admin, aws_cognito_user.standard_user]

  provisioner "local-exec" {
    interpreter = ["PowerShell", "-Command"]
    command     = "& 'C:/Program Files/Amazon/AWSCLIV2/aws.exe' cognito-idp admin-set-user-password --user-pool-id ${aws_cognito_user_pool.users.id} --username admin --password '${var.admin_password}' --permanent; & 'C:/Program Files/Amazon/AWSCLIV2/aws.exe' cognito-idp admin-set-user-password --user-pool-id ${aws_cognito_user_pool.users.id} --username cory --password '${var.user_password}' --permanent"
  }
}

# Tells API Gateway: only let requests through with a valid Cognito login token
resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.chat_api.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "cognito-authorizer"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.app_client.id]
    issuer   = "https://cognito-idp.us-west-1.amazonaws.com/${aws_cognito_user_pool.users.id}"
  }
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.users.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.app_client.id
}
