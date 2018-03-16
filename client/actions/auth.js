import axios from 'axios';
import { isTokenExpired, decodeToken } from '../utils/auth';

import * as constants from '../constants';

export function logout() {
  return (dispatch) => {
    localStorage.removeItem('logs-to-aws-s3:apiToken');
    sessionStorage.removeItem('logs-to-aws-s3:apiToken');

    window.location = window.config.AUTH0_MANAGE_URL;

    dispatch({
      type: constants.LOGOUT_SUCCESS
    });
  };
}

export function loadCredentials() {
  return (dispatch) => {
    const apiToken = sessionStorage.getItem('logs-to-aws-s3:apiToken');
    if (apiToken) {
      const decodedToken = decodeToken(apiToken);

      if (isTokenExpired(decodedToken)) {
        return;
      }

      axios.defaults.headers.common.Authorization = `Bearer ${apiToken}`;
      sessionStorage.setItem('logs-to-aws-s3:apiToken', apiToken);

      dispatch({
        type: constants.RECIEVED_TOKEN,
        payload: {
          token: apiToken
        }
      });

      dispatch({
        type: constants.LOGIN_SUCCESS,
        payload: {
          token: apiToken,
          decodedToken,
          user: decodedToken
        }
      });

      return;
    }
  };
}
