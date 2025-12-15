import { useState, useEffect } from "preact/hooks";
import { useWebSocket } from "../lib/websocket";
import { api, CloudAuthStatus } from "../lib/api";
import { Cloud, CloudOff, LogOut, Loader2, Mail, Lock, Key } from "lucide-preact";
import { useToast } from "../lib/toast";

export function Settings() {
  const { deviceConnected, currentWeight } = useWebSocket();
  const { showToast } = useToast();

  // Cloud auth state
  const [cloudStatus, setCloudStatus] = useState<CloudAuthStatus | null>(null);
  const [loadingCloud, setLoadingCloud] = useState(true);
  const [loginStep, setLoginStep] = useState<'idle' | 'credentials' | 'verify'>('idle');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Fetch cloud status on mount
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const status = await api.getCloudStatus();
        setCloudStatus(status);
      } catch (e) {
        console.error('Failed to fetch cloud status:', e);
      } finally {
        setLoadingCloud(false);
      }
    };
    fetchStatus();
  }, []);

  const handleLogin = async () => {
    if (!email || !password) {
      setLoginError('Email and password are required');
      return;
    }

    setLoginLoading(true);
    setLoginError(null);

    try {
      const result = await api.cloudLogin(email, password);

      if (result.success) {
        // Direct login success (rare)
        const status = await api.getCloudStatus();
        setCloudStatus(status);
        setLoginStep('idle');
        setEmail('');
        setPassword('');
        showToast('success', 'Logged in to Bambu Cloud');
      } else if (result.needs_verification) {
        // Need verification code
        setLoginStep('verify');
        showToast('info', 'Check your email for verification code');
      } else {
        setLoginError(result.message);
      }
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : 'Login failed');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleVerify = async () => {
    if (!verifyCode) {
      setLoginError('Verification code is required');
      return;
    }

    setLoginLoading(true);
    setLoginError(null);

    try {
      const result = await api.cloudVerify(email, verifyCode);

      if (result.success) {
        const status = await api.getCloudStatus();
        setCloudStatus(status);
        setLoginStep('idle');
        setEmail('');
        setPassword('');
        setVerifyCode('');
        showToast('success', 'Logged in to Bambu Cloud');
      } else {
        setLoginError(result.message);
      }
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await api.cloudLogout();
      setCloudStatus({ is_authenticated: false, email: null });
      showToast('success', 'Logged out of Bambu Cloud');
    } catch (e) {
      showToast('error', 'Failed to logout');
    }
  };

  const cancelLogin = () => {
    setLoginStep('idle');
    setEmail('');
    setPassword('');
    setVerifyCode('');
    setLoginError(null);
  };

  const handleTare = async () => {
    try {
      await api.tareScale();
    } catch (e) {
      console.error("Failed to tare:", e);
      alert("Failed to tare scale");
    }
  };

  return (
    <div class="space-y-6">
      {/* Header */}
      <div>
        <h1 class="text-3xl font-bold text-[var(--text-primary)]">Settings</h1>
        <p class="text-[var(--text-secondary)]">Configure SpoolBuddy</p>
      </div>

      {/* Device settings */}
      <div class="card">
        <div class="px-6 py-4 border-b border-[var(--border-color)]">
          <h2 class="text-lg font-medium text-[var(--text-primary)]">Device</h2>
        </div>
        <div class="p-6 space-y-6">
          {/* Connection status */}
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-sm font-medium text-[var(--text-primary)]">Connection Status</h3>
              <p class="text-sm text-[var(--text-secondary)]">
                SpoolBuddy device connection
              </p>
            </div>
            <span
              class={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
                deviceConnected
                  ? "bg-green-500/20 text-green-500"
                  : "bg-red-500/20 text-red-500"
              }`}
            >
              {deviceConnected ? "Connected" : "Disconnected"}
            </span>
          </div>

          {/* Scale */}
          <div class="border-t border-[var(--border-color)] pt-6">
            <h3 class="text-sm font-medium text-[var(--text-primary)]">Scale</h3>
            <div class="mt-4 flex items-center justify-between">
              <div>
                <p class="text-sm text-[var(--text-secondary)]">Current reading</p>
                <p class="text-2xl font-mono text-[var(--text-primary)]">
                  {currentWeight !== null ? `${currentWeight.toFixed(1)}g` : "--"}
                </p>
              </div>
              <div class="space-x-3">
                <button
                  onClick={handleTare}
                  disabled={!deviceConnected}
                  class="btn"
                >
                  Tare Scale
                </button>
                <button
                  disabled={!deviceConnected}
                  class="btn"
                >
                  Calibrate
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bambu Cloud settings */}
      <div class="card">
        <div class="px-6 py-4 border-b border-[var(--border-color)]">
          <div class="flex items-center gap-2">
            <Cloud class="w-5 h-5 text-[var(--text-muted)]" />
            <h2 class="text-lg font-medium text-[var(--text-primary)]">Bambu Cloud</h2>
          </div>
        </div>
        <div class="p-6 space-y-4">
          {loadingCloud ? (
            <div class="flex items-center gap-2 text-[var(--text-muted)]">
              <Loader2 class="w-4 h-4 animate-spin" />
              <span>Checking cloud status...</span>
            </div>
          ) : cloudStatus?.is_authenticated ? (
            /* Logged in state */
            <div class="space-y-4">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
                    <Cloud class="w-5 h-5 text-green-500" />
                  </div>
                  <div>
                    <p class="text-sm font-medium text-[var(--text-primary)]">Connected</p>
                    <p class="text-sm text-[var(--text-secondary)]">{cloudStatus.email}</p>
                  </div>
                </div>
                <button onClick={handleLogout} class="btn flex items-center gap-2">
                  <LogOut class="w-4 h-4" />
                  Logout
                </button>
              </div>
              <p class="text-sm text-[var(--text-muted)]">
                Your custom filament presets will be available when adding spools.
              </p>
            </div>
          ) : loginStep === 'idle' ? (
            /* Not logged in - show login button */
            <div class="space-y-4">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-full bg-[var(--text-muted)]/20 flex items-center justify-center">
                  <CloudOff class="w-5 h-5 text-[var(--text-muted)]" />
                </div>
                <div>
                  <p class="text-sm font-medium text-[var(--text-primary)]">Not Connected</p>
                  <p class="text-sm text-[var(--text-secondary)]">Login to access custom filament presets</p>
                </div>
              </div>
              <button
                onClick={() => setLoginStep('credentials')}
                class="btn btn-primary flex items-center gap-2"
              >
                <Cloud class="w-4 h-4" />
                Login to Bambu Cloud
              </button>
            </div>
          ) : loginStep === 'credentials' ? (
            /* Login form */
            <div class="space-y-4">
              <p class="text-sm text-[var(--text-secondary)]">
                Enter your Bambu Lab account credentials. A verification code will be sent to your email.
              </p>

              {loginError && (
                <div class="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-500 text-sm">
                  {loginError}
                </div>
              )}

              <div class="space-y-3">
                <div>
                  <label class="label">Email</label>
                  <div class="relative">
                    <Mail class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                    <input
                      type="email"
                      class="input input-with-icon"
                      placeholder="your@email.com"
                      value={email}
                      onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
                      disabled={loginLoading}
                    />
                  </div>
                </div>
                <div>
                  <label class="label">Password</label>
                  <div class="relative">
                    <Lock class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                    <input
                      type="password"
                      class="input input-with-icon"
                      placeholder="Password"
                      value={password}
                      onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                      disabled={loginLoading}
                      onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                    />
                  </div>
                </div>
              </div>

              <div class="flex gap-3">
                <button onClick={cancelLogin} class="btn" disabled={loginLoading}>
                  Cancel
                </button>
                <button onClick={handleLogin} class="btn btn-primary flex items-center gap-2" disabled={loginLoading}>
                  {loginLoading ? <Loader2 class="w-4 h-4 animate-spin" /> : null}
                  {loginLoading ? 'Logging in...' : 'Login'}
                </button>
              </div>
            </div>
          ) : (
            /* Verification code step */
            <div class="space-y-4">
              <p class="text-sm text-[var(--text-secondary)]">
                A verification code has been sent to <strong>{email}</strong>. Enter it below.
              </p>

              {loginError && (
                <div class="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-500 text-sm">
                  {loginError}
                </div>
              )}

              <div>
                <label class="label">Verification Code</label>
                <div class="relative">
                  <Key class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                  <input
                    type="text"
                    class="input input-with-icon"
                    placeholder="Enter 6-digit code"
                    value={verifyCode}
                    onInput={(e) => setVerifyCode((e.target as HTMLInputElement).value)}
                    disabled={loginLoading}
                    onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
                  />
                </div>
              </div>

              <div class="flex gap-3">
                <button onClick={cancelLogin} class="btn" disabled={loginLoading}>
                  Cancel
                </button>
                <button onClick={handleVerify} class="btn btn-primary flex items-center gap-2" disabled={loginLoading}>
                  {loginLoading ? <Loader2 class="w-4 h-4 animate-spin" /> : null}
                  {loginLoading ? 'Verifying...' : 'Verify'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Server settings */}
      <div class="card">
        <div class="px-6 py-4 border-b border-[var(--border-color)]">
          <h2 class="text-lg font-medium text-[var(--text-primary)]">Server</h2>
        </div>
        <div class="p-6 space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-sm font-medium text-[var(--text-primary)]">Version</h3>
              <p class="text-sm text-[var(--text-secondary)]">SpoolBuddy server version</p>
            </div>
            <span class="text-sm font-mono text-[var(--text-muted)]">0.1.0</span>
          </div>
          <div class="border-t border-[var(--border-color)] pt-4">
            <div>
              <h3 class="text-sm font-medium text-[var(--text-primary)]">Database</h3>
              <p class="text-sm text-[var(--text-secondary)]">SQLite database for spool inventory</p>
            </div>
          </div>
        </div>
      </div>

      {/* About */}
      <div class="card">
        <div class="px-6 py-4 border-b border-[var(--border-color)]">
          <h2 class="text-lg font-medium text-[var(--text-primary)]">About</h2>
        </div>
        <div class="p-6">
          <p class="text-sm text-[var(--text-secondary)]">
            SpoolBuddy is a filament management system for Bambu Lab 3D printers.
          </p>
          <p class="mt-2 text-sm text-[var(--text-secondary)]">
            Features include NFC tag reading, weight scale integration, and automatic AMS configuration.
          </p>
          <div class="mt-4 flex space-x-4">
            <a
              href="https://github.com/maziggy/spoolbuddy"
              target="_blank"
              rel="noopener noreferrer"
              class="text-sm text-[var(--accent-color)] hover:text-[var(--accent-hover)]"
            >
              GitHub
            </a>
            <a
              href="https://github.com/maziggy/spoolbuddy/issues"
              target="_blank"
              rel="noopener noreferrer"
              class="text-sm text-[var(--accent-color)] hover:text-[var(--accent-hover)]"
            >
              Report Issue
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
