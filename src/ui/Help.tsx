export function Help() {
  return (
    <section class="help">
      <h1>Help</h1>
      <p class="hint">Everything you need, in plain words.</p>

      <div class="card">
        <h2>Upload files</h2>
        <ol>
          <li>Click <strong>Upload files</strong> (or <strong>Upload a folder</strong>) at the top of <a href="#/">My files</a> and choose what to save.</li>
          <li>Check the name. It's filled in for you, so you can leave it as it is.</li>
          <li>Click the big <strong>Upload</strong> button and wait for the green "✓ Uploaded" message.</li>
        </ol>
      </div>

      <div class="card">
        <h2>Download files</h2>
        <ol>
          <li>On <a href="#/">My files</a>, click <strong>Download</strong> next to a save to get everything in it. Or click its name to see the files inside.</li>
          <li>Inside a save, click <strong>Download all</strong>, or <strong>Download</strong> next to one file. Look in your computer's Downloads folder.</li>
        </ol>
      </div>

      <div class="card">
        <h2>Delete a save</h2>
        <ol>
          <li>Click the save's name, then <strong>More options</strong>, then <strong>Delete this save…</strong></li>
          <li>Type the save's name to confirm, then click <strong>Delete permanently</strong>.</li>
        </ol>
        <p><strong>Deleting here never deletes the original files on your computer.</strong> It only removes the copy in your cloud storage.</p>
      </div>

      <div class="card">
        <h2>Using a new computer</h2>
        <ol>
          <li>Open this website and click <strong>Sign in with GitHub</strong>. Use the same GitHub account as before. Your files appear right away.</li>
          <li>GitHub may ask for a <strong>verification code</strong> to check it's really you. <strong>That code comes from GitHub, not from fsave-web</strong>, and fsave-web never sees it.</li>
          <li>This only happens on a new computer, or after you click <strong>Sign out</strong>. Otherwise this computer remembers you.</li>
        </ol>
      </div>

      <div class="card">
        <h2>The verification code didn't arrive</h2>
        <ol>
          <li>Check your <strong>spam</strong> or junk folder.</li>
          <li>Make sure you're looking in the right inbox. GitHub sends the code to the email address on your GitHub account, which may not be the one you check most.</li>
          <li>Wait a minute or two, then click <strong>Resend</strong> on the GitHub page.</li>
          <li>Better: approve with <strong>GitHub Mobile</strong> (one tap on your phone) or a <strong>passkey</strong> (your fingerprint, face or PIN). On the GitHub page, look for <strong>Use GitHub Mobile</strong> or <strong>Use a passkey</strong> instead of the email code.</li>
          <li>Last resort: use one of your <strong>recovery codes</strong> (GitHub gave you a set when you turned on two-step sign-in). Keep them somewhere safe, and get a fresh set from GitHub after you use any.</li>
        </ol>
      </div>

      <div class="card">
        <h2>Good to know</h2>
        <ul>
          <li>Your files are kept in a private storage area that only you can open.</li>
          <li>You stay signed in on each computer until GitHub says it's time to sign in again.</li>
          <li>Use <strong>Sign out</strong> in <a href="#/settings">Settings</a> on a computer you share with other people.</li>
        </ul>
      </div>
    </section>
  );
}
