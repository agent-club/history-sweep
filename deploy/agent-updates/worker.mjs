import { BUNDLE_FILES } from '../../agent/metadata.mjs';

const githubFeed = 'https://raw.githubusercontent.com/agent-club/history-sweep/refs/heads/feature/agent-updates';
const releasePath = /^\/agent\/releases\/[0-9]+\.[0-9]+\.[0-9]+\/(.+)$/;

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const releaseFile = releasePath.exec(pathname)?.[1];
    if (pathname !== '/agent/latest.json' && pathname !== '/agent/bootstrap.mjs' && !BUNDLE_FILES.includes(releaseFile)) {
      return new Response(null, { status: 404 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    let upstream;
    try {
      // Released companions require this origin and reject redirects. Fetch only the public artifact URL.
      upstream = await fetch(`${githubFeed}${pathname}`, { method: request.method, redirect: 'manual' });
    } catch {
      return new Response(null, { status: 502 });
    }
    if (upstream.status !== 200) {
      return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
    }
    const mediaType = pathname.endsWith('.json') ? 'application/json'
      : pathname.endsWith('.md') ? 'text/markdown' : 'text/javascript';
    return new Response(upstream.body, {
      headers: {
        'Content-Type': `${mediaType}; charset=utf-8`,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
};
