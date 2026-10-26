export const NAMEPLATE_VARIANTS = Object.freeze(['obsidian', 'ivory', 'aurora', 'gold']);

function validate(card) {
  if (!card || card.version !== 1 || !NAMEPLATE_VARIANTS.includes(card.variant) ||
      typeof card.number !== 'string' || !/^[0-9A-F]{8}$/.test(card.number) ||
      typeof card.issuedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(card.issuedOn) ||
      new Date(`${card.issuedOn}T12:00:00Z`).toISOString().slice(0, 10) !== card.issuedOn) {
    throw new Error('Invalid nameplate');
  }
  return card;
}

export function createNameplateStore(storage, { random = () => crypto.getRandomValues(new Uint32Array(2)), now = () => new Date() } = {}) {
  let queue = Promise.resolve();
  function serialize(action) {
    const operation = queue.then(action);
    queue = operation.catch(() => {});
    return operation;
  }
  async function issue() {
    const { nameplate } = await storage.get('nameplate');
    if (nameplate !== undefined) return validate(nameplate);
    const values = random();
    const date = now();
    const card = validate({
      version: 1,
      variant: NAMEPLATE_VARIANTS[values[0] % NAMEPLATE_VARIANTS.length],
      number: values[1].toString(16).padStart(8, '0').toUpperCase(),
      // Existing installations join when first issued; no historical install date is invented.
      issuedOn: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    });
    await storage.set({ nameplate: card });
    return card;
  }
  return {
    // The worker serializes all surfaces so a simultaneous open cannot reroll a card.
    issue: () => serialize(issue),
    prepareReveal: () => serialize(async () => {
      const card = await issue();
      await storage.set({ nameplateRevealPending: true });
      return card;
    }),
    claimReveal: () => serialize(async () => {
      const { nameplateRevealPending } = await storage.get('nameplateRevealPending');
      if (nameplateRevealPending !== true) return null;
      const card = await issue();
      // Claim before displaying: only one extension surface owns the installation reveal.
      await storage.set({ nameplateRevealPending: false });
      return card;
    }),
  };
}
