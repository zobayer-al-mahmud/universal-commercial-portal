/**
 * BGMEA portal — sign-in selectors (confirmed on the live bgmea.org login page:
 * ASP.NET MVC form #Username / #Password + anti-forgery token, no CAPTCHA at
 * inspection). The UD section read/write map lives in portal-map.ts.
 */

export const BGMEA_LOGIN = {
  usernameSelector: "#Username",
  passwordSelector: "#Password",
  submitSelector: 'form button[type="submit"]',
  loginPathFragment: "/Account/Login",
};
