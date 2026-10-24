// Build-time settings for "Sign in with GitHub". All three values are public (no secrets here);
// they are supplied as repository variables in the deploy workflow. If any is missing, the
// sign-in button is hidden and the pasted-token option is shown instead.
export const authConfig = {
  clientId: (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined) ?? '',
  appSlug: (import.meta.env.VITE_GITHUB_APP_SLUG as string | undefined) ?? '',
  workerUrl: ((import.meta.env.VITE_OAUTH_WORKER_URL as string | undefined) ?? '').replace(/\/+$/, ''),
};
export const oauthEnabled = !!(authConfig.clientId && authConfig.appSlug && authConfig.workerUrl);

export const installUrl = (slug = authConfig.appSlug) => `https://github.com/apps/${slug}/installations/new`;
