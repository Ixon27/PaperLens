// Google 데스크톱 OAuth 클라이언트는 비밀이 아니다(Google 문서 기준). 개발자가 클라이언트를 만든 뒤 채운다.
const BUILT_IN_CLIENT_ID = "26156587302-qtn2bt3qrju1dff71aibcgg1o0c8ftni.apps.googleusercontent.com";
const BUILT_IN_CLIENT_SECRET = "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";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  apiUrl: string;
}

export const SYNC_SCOPES: readonly string[] = ['openid', 'email', 'https://www.googleapis.com/auth/drive.appdata'];

export function googleConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfig {
  const pick = (key: string, fallback: string) => env[key]?.trim() || fallback;
  return {
    clientId: pick('PAPERLENS_GOOGLE_CLIENT_ID', BUILT_IN_CLIENT_ID),
    clientSecret: pick('PAPERLENS_GOOGLE_CLIENT_SECRET', BUILT_IN_CLIENT_SECRET),
    authUrl: pick('PAPERLENS_GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
    tokenUrl: pick('PAPERLENS_GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    revokeUrl: pick('PAPERLENS_GOOGLE_REVOKE_URL', 'https://oauth2.googleapis.com/revoke'),
    apiUrl: pick('PAPERLENS_GOOGLE_API_URL', 'https://www.googleapis.com').replace(/\/+$/, ''),
  };
}
