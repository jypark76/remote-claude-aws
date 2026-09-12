variable "anthropic_api_key" {
  description = "API key from console.anthropic.com. Set via TF_VAR_anthropic_api_key env var, never commit it."
  type        = string
  sensitive   = true
  default     = "not-set-yet"
}

variable "admin_password" {
  description = "Login password for the 'admin' account. Set via TF_VAR_admin_password."
  type        = string
  sensitive   = true
}

variable "user_password" {
  description = "Login password for the 'user' account. Set via TF_VAR_user_password."
  type        = string
  sensitive   = true
}
