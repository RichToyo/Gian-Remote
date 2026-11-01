import { beforeEach, describe, expect, it } from 'vitest';
import { createHostSelectionStore } from '../src/host-selection.js';
import { createBrowserIdentityStore } from '../src/transport/identity.js';

beforeEach(() => localStorage.clear());

describe('Desktop Server storage scopes', () => {
  it('keeps Host selection and browser installation ids independent A -> B -> A', async () => {
    const a = 'https://a.remote.test', b = 'https://b.remote.test';
    const selectionA = createHostSelectionStore(a), selectionB = createHostSelectionStore(b);
    selectionA.set('host-a'); selectionB.set('host-b');
    expect(selectionA.get()).toBe('host-a');
    expect(selectionB.get()).toBe('host-b');

    const identityA = createBrowserIdentityStore(a), identityB = createBrowserIdentityStore(b);
    const installationA = await identityA.browserInstallationId();
    const installationB = await identityB.browserInstallationId();
    expect(installationA).not.toBe(installationB);
    await identityA.clearAll();
    expect(await identityA.browserInstallationId()).not.toBe(installationA);
    expect(await identityB.browserInstallationId()).toBe(installationB);
    expect(selectionA.get()).toBe('host-a');
  });
});
