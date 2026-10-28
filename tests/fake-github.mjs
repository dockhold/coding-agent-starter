// A fake of the parts of the GitHub REST API the app uses, for one
// repository (octo-org/website). Used by tests/loop.test.mjs, and run on its
// own by tests/smoke.sh inside the image:
//   node fake-github.mjs serve <port> <state-file>
// serves on the loopback address with one open labelled issue (#1) and
// writes the pull requests and comments to <state-file> as they come in.
import fs from 'node:fs';
import http from 'node:http';

const OWNER_REPO = 'octo-org/website';

export function fakeGitHub() {
  const db = { issues: [], labels: new Map(), comments: [], pulls: [], auth: new Set(), perms: new Map(), failLabel: new Set() };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      db.auth.add(req.headers.authorization);
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : null;
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      const p = url.pathname.replace(`/repos/${OWNER_REPO}`, '');
      let m;
      if (req.method === 'GET' && p === '') return send(200, { default_branch: 'main' });
      if (req.method === 'GET' && p === '/issues') {
        const label = url.searchParams.get('labels');
        return send(200, db.issues.filter((i) => db.labels.get(i.number)?.has(label)));
      }
      if ((m = p.match(/^\/issues\/(\d+)\/labels\/(.+)$/)) && req.method === 'DELETE') {
        const set = db.labels.get(Number(m[1]));
        if (!set?.delete(decodeURIComponent(m[2]))) return send(404, { message: 'Label does not exist' });
        return send(200, []);
      }
      if ((m = p.match(/^\/collaborators\/([^/]+)\/permission$/)) && req.method === 'GET') {
        const perm = db.perms.get(decodeURIComponent(m[1]));
        return perm ? send(200, perm) : send(404, { message: 'Not Found' });
      }
      if ((m = p.match(/^\/issues\/(\d+)\/labels$/)) && req.method === 'POST') {
        if (db.failLabel.has(Number(m[1]))) return send(500, { message: 'Server Error' });
        for (const l of body.labels) db.labels.get(Number(m[1])).add(l);
        return send(200, []);
      }
      if ((m = p.match(/^\/issues\/(\d+)\/comments$/)) && req.method === 'POST') {
        db.comments.push({ issue: Number(m[1]), body: body.body });
        return send(201, {});
      }
      if (p === '/pulls' && req.method === 'GET') {
        return send(200, db.pulls.filter((pr) => `octo-org:${pr.head}` === url.searchParams.get('head')));
      }
      if (p === '/pulls' && req.method === 'POST') {
        const pr = { ...body, number: 100 + db.pulls.length, html_url: `https://github.com/${OWNER_REPO}/pull/${100 + db.pulls.length}` };
        db.pulls.push(pr);
        return send(201, pr);
      }
      if ((m = p.match(/^\/pulls\/(\d+)$/)) && req.method === 'PATCH') {
        Object.assign(db.pulls.find((pr) => pr.number === Number(m[1])), body);
        return send(200, {});
      }
      return send(404, { message: 'Not Found' });
    });
  });
  return { db, server };
}

if (process.argv[2] === 'serve') {
  const [port, stateFile] = [Number(process.argv[3]), process.argv[4]];
  const { db, server } = fakeGitHub();
  db.issues.push({ number: 1, title: 'Fix the greeting', body: 'Say hello.', author_association: 'OWNER', user: { login: 'octo-owner' }, created_at: '2026-10-01T00:00:00Z' });
  db.labels.set(1, new Set(['agent']));
  server.listen(port, '127.0.0.1');
  setInterval(() => fs.writeFileSync(stateFile, JSON.stringify({ pulls: db.pulls, comments: db.comments })), 250);
}
