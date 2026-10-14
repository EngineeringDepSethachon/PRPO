// @vitest-environment jsdom
import React, { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const handleSwitchUser = vi.fn();
const errorSpy = vi.fn();

vi.mock('../src/context/AppContext', () => ({
  useAppContext: () => ({ handleSwitchUser })
}));
vi.mock('../src/services/modalService', () => ({
  modalService: { error: (...a) => errorSpy(...a), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
}));

import LoginView from '../src/views/auth/LoginView.jsx';
import { AuthProvider, useAuth } from '../src/context/AuthContext.jsx';

const setInput = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('LoginView after login (cloudflare mode)', () => {
  let container, root, authRef;
  const Spy = () => { authRef = useAuth(); return null; };

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    localStorage.clear();
    sessionStorage.clear();
    handleSwitchUser.mockClear();
    errorSpy.mockClear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ token: 'tok1', user: { id: 'U1', username: 'u', name: 'U', roleId: 'REQUESTER_PD', department: 'PD', level: 1 } })
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('does not call handleSwitchUser / modalService.error; AuthContext holds the token user', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AuthProvider>
            <Spy />
            <LoginView />
          </AuthProvider>
        </MemoryRouter>
      );
    });
    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInput(inputs[0], 'u');
      setInput(inputs[1], 'pw');
    });
    await act(async () => {
      container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(handleSwitchUser).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(authRef.currentUser?.username).toBe('u');
    expect(authRef.currentUser?.token).toBe('tok1');
  });
});
