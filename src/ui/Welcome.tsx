import { installUrl } from '../auth/config';
import { useApp } from './app';

/** The only screen shown when you are not signed in. */
export function Welcome() {
  const { oauth, signIn, signOut, recheck } = useApp();
  const again = () => void recheck();

  return (
    <section class="welcome">
      <div class="logo" aria-hidden="true">💾</div>
      <h1>fsave-web</h1>
      <p class="lead">Save files to your private cloud and get them back from any computer.</p>

      {!oauth.signedIn && (
        <>
          {oauth.expired && <p role="alert" class="notice error">Your sign-in ran out, so please sign in again.</p>}
          {oauth.state === 'error' && <p role="alert" class="notice error">{oauth.message}</p>}
          <button type="button" class="primary big" onClick={signIn}>Sign in with GitHub</button>
          <p class="muted fine">
            You'll sign in with your GitHub account (GMShannon99). On a new computer, GitHub (not fsave-web) may ask for a verification code. If the email doesn't arrive, check your spam folder, or approve it in the GitHub Mobile app on your phone. After that, this computer remembers you. <a href="#/help">More help</a>
          </p>
        </>
      )}

      {oauth.signedIn && oauth.state === 'checking' && <p role="status" class="lead">Signing you in…</p>}

      {oauth.signedIn && oauth.state === 'needs-install' && (
        <div class="card step">
          <h2>One more step</h2>
          <p>GitHub needs your OK before fsave-web can use your storage folder (<strong>{oauth.repo}</strong>).</p>
          <ol>
            <li>Click <strong>Allow access to my storage</strong> below. GitHub opens.</li>
            <li>Choose <strong>Only select repositories</strong>, then pick your storage folder from the list.</li>
            <li>Click <strong>Install</strong>. You'll come back here automatically.</li>
          </ol>
          <div class="actions">
            <a class="button primary big" href={installUrl()}>Allow access to my storage</a>
            <button type="button" onClick={again}>I've done this — continue</button>
          </div>
        </div>
      )}

      {oauth.signedIn && oauth.state === 'public' && (
        <p role="alert" class="notice error">
          Your storage folder <strong>{oauth.repo}</strong> is set to <strong>public</strong>, so anyone on the internet could see your files. On GitHub, open that folder's Settings and change its visibility to private, then <button type="button" class="link" onClick={again}>try again</button>.
        </p>
      )}
      {oauth.signedIn && oauth.state === 'no-write' && (
        <p role="alert" class="notice error">
          fsave-web is signed in but isn't allowed to save into <strong>{oauth.repo}</strong>. Open the app's settings on GitHub and allow "Contents: Read and write", then <button type="button" class="link" onClick={again}>try again</button>.
        </p>
      )}
      {oauth.signedIn && oauth.state === 'error' && (
        <p role="alert" class="notice error">
          {oauth.message} <button type="button" class="link" onClick={again}>Try again</button>
        </p>
      )}
      {oauth.signedIn && oauth.state !== 'checking' && (
        <p><button type="button" class="link" onClick={signOut}>Sign out</button></p>
      )}
    </section>
  );
}
