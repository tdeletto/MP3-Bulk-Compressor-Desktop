'use strict';
/**
 * UI end-to-end test: launches the real app, picks a folder, runs a batch, and checks the files on disk.
 *
 *   npm run test:e2e                        # the development build (electron .)
 *   APP_PATH=/path/to/app npm run test:e2e  # a packaged build, e.g.
 *     "dist/mac-arm64/MP3 Bulk Compressor Desktop.app/Contents/MacOS/MP3 Bulk Compressor Desktop"
 *   SCREENSHOTS=1 npm run test:e2e          # also refresh docs/screenshot-*.png
 *
 * Native dialogs and the system Trash are stubbed inside the main process, so the test never touches
 * anything outside its own temp folder.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..', '..');
const FULL = path.join(ROOT, 'test', 'fixtures', 'full');
const SHOTS = process.env.SCREENSHOTS === '1';

function makeLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3bulk-ui-'));
  const lib = path.join(dir, 'Podcasts');
  fs.mkdirSync(path.join(lib, 'Season 2'), { recursive: true });
  fs.copyFileSync(path.join(FULL, 'cbr320_joint_tags.mp3'), path.join(lib, 'Episode 01 - Welcome.mp3'));
  fs.copyFileSync(path.join(FULL, 'vbr_v2_stereo.mp3'), path.join(lib, 'Episode 02 - Interview.mp3'));
  fs.copyFileSync(path.join(FULL, 'cbr64_mono.mp3'), path.join(lib, 'Trailer.mp3'));
  fs.copyFileSync(path.join(FULL, 'cbr320_joint_tags.mp3'), path.join(lib, 'Season 2', 'Episode 03 - Q&A.mp3'));
  fs.copyFileSync(path.join(FULL, 'damaged_truncated_vbr.mp3'), path.join(lib, 'Season 2', 'Episode 04 - Broken upload.mp3'));
  const trash = path.join(dir, 'Trash');
  fs.mkdirSync(trash);
  return { lib, trash };
}

async function main() {
  const { lib, trash } = makeLibrary();
  const launch = process.env.APP_PATH
    ? { executablePath: process.env.APP_PATH, args: [] }
    : { executablePath: require('electron'), args: [ROOT] };
  const app = await electron.launch({ ...launch, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });

  try {
    // Stub the folder picker and the Trash in the main process.
    await app.evaluate(({ dialog, shell }, { lib, trash }) => {
      const fs = process.mainModule.require('fs');
      const path = process.mainModule.require('path');
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [lib] });
      shell.trashItem = async (p) => fs.renameSync(p, path.join(trash, path.basename(p)));
    }, { lib, trash });

    const page = await app.firstWindow();
    await page.waitForSelector('#pick-folder');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 860));
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('#pick-folder');

    // Only the setup view is actually visible at launch (checks rendering, not just attributes).
    assert.ok(await page.isVisible('#setup-view'));
    for (const sel of ['#run-view', '#drop-overlay', '#stop', '#done']) {
      assert.equal(await page.isVisible(sel), false, `${sel} should not be visible at launch`);
    }

    // Keep-everything default: the Compress button stays disabled.
    await page.click('#pick-folder');
    await page.waitForFunction(() => /3 MP3 files/.test(document.querySelector('#source-summary').textContent));
    assert.ok(await page.isDisabled('#compress'), 'all-Keep settings should not allow compressing');

    // Include subfolders → 5 files.
    await page.click('.switch-row');
    await page.waitForFunction(() => /5 MP3 files/.test(document.querySelector('#source-summary').textContent));

    // Podcast preset selects the matching chips and updates the subtitle.
    await page.click('[data-preset="PODCAST"]');
    assert.match(await page.textContent('#subtitle'), /VBR • 64 kbps • 44,100 Hz • Mono/);
    assert.equal(await page.getAttribute('[data-setting="mode"][data-value="\\"VBR\\""]', 'aria-checked'), 'true');
    assert.equal(await page.textContent('#compress-label'), 'Compress 5 files');
    // Changing a chip turns the preset into Custom.
    await page.click('[data-setting="kbps"][data-value="48"]');
    assert.equal(await page.$('.preset.selected'), null);
    await page.click('[data-preset="PODCAST"]');
    if (SHOTS) await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshot-setup.png') });

    // Run a "save a copy" batch.
    await page.click('#compress');
    await page.waitForSelector('#done:not([hidden])', { timeout: 120000 });
    assert.equal(await page.textContent('#run-count'), '5 of 5');
    assert.equal(await page.isVisible('#setup-view'), false, 'setup view hides during a run');
    assert.equal(await page.isVisible('#compress'), false);
    assert.equal(await page.textContent('#stat-failed'), '1');
    assert.equal(await page.locator('.result').count(), 5);
    await page.click('#log-toggle');
    await page.waitForSelector('#log li');
    assert.match(await page.textContent('#log'), /Batch complete\./);
    if (SHOTS) {
      await page.waitForTimeout(500); // let the progress bar's width transition finish
      await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshot-results.png') });
    }

    const top = fs.readdirSync(lib).sort();
    assert.ok(top.includes('Episode 01 - Welcome - SHRUNK.mp3'), `copies saved: ${top}`);
    assert.ok(top.includes('Episode 01 - Welcome.mp3'), 'original kept');
    assert.ok(!fs.readdirSync(path.join(lib, 'Season 2')).some((n) => n.startsWith('Episode 04') && n.includes('SHRUNK')),
      'damaged file must not produce output');

    // Done → back to setup; the rescan ignores the new " - SHRUNK" files.
    await page.click('#done');
    await page.waitForSelector('#setup-view:not([hidden])');
    await page.waitForFunction(() => /5 MP3 files/.test(document.querySelector('#source-summary').textContent));

    // Replace originals (Trash is stubbed): confirm dialog, then originals move to the fake Trash.
    await page.click('[data-preset="HQ_MUSIC"]');
    await page.check('#output-replace');
    await page.click('#compress');
    await page.click('#confirm-ok');
    await page.waitForSelector('#done:not([hidden])', { timeout: 120000 });
    const trashed = fs.readdirSync(trash);
    assert.ok(trashed.includes('Episode 01 - Welcome.mp3'), `trashed: ${trashed}`);
    assert.ok(fs.existsSync(path.join(lib, 'Episode 01 - Welcome.mp3')), 'new file took the original name');
    assert.ok((await page.locator('.badge.replaced').count()) >= 1);

    console.log('UI end-to-end test passed');
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
