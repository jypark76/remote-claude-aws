// In plain English: this file holds a few settings the rest of the app
// needs to know - which login service to talk to, and where the server
// lives. Neither ID below is a secret - they're like a shop's public
// street address, not a key to the safe.
export const COGNITO_USER_POOL_ID = "us-east-2_HteJiaJRw";
export const COGNITO_CLIENT_ID = "2i3n92b14gl2gb6pl7jmivosdr";
// Relative to whatever origin served this page — works whether that's the
// raw EC2 IP (http://18.223.109.77:5000) or a CloudFront HTTPS domain, since
// CloudFront proxies both the site and the API to the same EC2 origin.
export const API_BASE = "";
