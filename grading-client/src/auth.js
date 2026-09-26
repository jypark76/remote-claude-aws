// In plain English: this whole file is "the login desk." It talks to AWS
// Cognito (the outside login service) so the app itself never has to
// handle raw passwords - it just asks Cognito "is this username/password
// right?" and gets back a login token if so.
import { CognitoUserPool, CognitoUser, AuthenticationDetails } from "amazon-cognito-identity-js";
import { COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID } from "./config";

const pool = new CognitoUserPool({
  UserPoolId: COGNITO_USER_POOL_ID,
  ClientId: COGNITO_CLIENT_ID,
});

// Logs in with Cognito. Resolves with the ID token on success. If the account
// still has a temporary password, resolves with { newPasswordRequired: true }
// instead, and the caller must call completeNewPassword() next.
// In plain English: tries to log a user in. Either hands back a real
// login token, or says "you need to set a real password first."
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

// In plain English: finishes setting a brand-new permanent password when
// a temporary one was used to log in the first time.
export function completeNewPassword(user, newPassword) {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(newPassword, {}, {
      onSuccess: (session) => resolve(session.getIdToken().getJwtToken()),
      onFailure: (err) => reject(err),
    });
  });
}
