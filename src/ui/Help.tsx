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
          <li>GitHub may email you a code to check it's really you. If it doesn't arrive in a minute or two, look in your <strong>spam</strong> folder, then ask GitHub to send it again.</li>
          <li>If GitHub asks for a two-step code and you don't have your phone, use one of your <strong>recovery codes</strong> (GitHub gave you a set when you turned on two-step sign-in). They're a last resort, so keep them somewhere safe.</li>
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
