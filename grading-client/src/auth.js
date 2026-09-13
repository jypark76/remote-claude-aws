import { CognitoUserPool, CognitoUser, AuthenticationDetails } from "amazon-cognito-identity-js";
import { COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID } from "./config";

const pool = new CognitoUserPool({
  UserPoolId: COGNITO_USER_POOL_ID,
  ClientId: COGNITO_CLIENT_ID,
});

// Logs in with Cognito. Resolves with the ID token on success. If the account
// still has a temporary password, resolves with { newPasswordRequired: true }
// instead, and the caller must call completeNewPassword() next.
export function login(username, password) {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: username, Pool: pool });
    const details = new AuthenticationDetails({ Username: username, Password: password });

    user.authenticateUser(details, {
      onSuccess: (session) => resolve({ token: session.getIdToken().getJwtToken() }),
      onFailure: (err) => reject(err),
      newPasswordRequired: () => resolve({ newPasswordRequired: true, user }),
    });
  });
}

export function completeNewPassword(user, newPassword) {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(newPassword, {}, {
      onSuccess: (session) => resolve(session.getIdToken().getJwtToken()),
      onFailure: (err) => reject(err),
    });
  });
}
