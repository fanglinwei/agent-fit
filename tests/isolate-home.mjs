import { after } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Shared Skill fixtures must never read or write the developer's real user home.
const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-fit-user-')));
process.env.HOME = home;
if (process.platform === 'win32') process.env.USERPROFILE = home;
after(() => rm(home, { recursive: true, force: true }));
