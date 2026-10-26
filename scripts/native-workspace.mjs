// Functional suites enter the workspace through the real first-install surface.
// The dedicated nameplate suite verifies collection and animation behavior.
export async function enterWorkspace(frame) {
  await frame.waitForFunction(() => document.body.dataset.startup === 'nameplate' || !document.body.hasAttribute('data-startup'));
  if (await frame.locator('#nameplateDialog').evaluate(dialog => dialog.open)) {
    await frame.locator('.nameplate-close').click();
  }
  await frame.waitForFunction(() => {
    const app = document.querySelector('#app');
    return app && !app.inert && getComputedStyle(app).visibility === 'visible';
  });
}
