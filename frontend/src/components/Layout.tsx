import { ComponentChildren } from "preact";
import { Link, useLocation } from "wouter-preact";
import { useWebSocket } from "../lib/websocket";
import { useTheme } from "../lib/theme";
import { Sun, Moon } from "lucide-preact";

interface LayoutProps {
  children: ComponentChildren;
}

const navItems = [
  { path: "/", label: "Dashboard", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
  { path: "/inventory", label: "Inventory", icon: "M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" },
  { path: "/printers", label: "Printers", icon: "M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" },
  { path: "/settings", label: "Settings", icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" },
];

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const { deviceConnected, currentWeight } = useWebSocket();
  const { theme, toggleTheme } = useTheme();

  return (
    <div class="min-h-screen flex flex-col bg-[var(--bg-secondary)]">
      {/* Header */}
      <header class="bg-[var(--bg-header)] text-white shadow-lg">
        <div class="w-full px-4 sm:px-6 lg:px-8">
          <div class="flex items-center justify-between h-16">
            {/* Logo */}
            <div class="flex items-center">
              <Link href="/" class="flex items-center">
                <img
                  src="/spoolbuddy_logo_transparent.png"
                  alt="SpoolBuddy"
                  class="h-10"
                />
              </Link>
            </div>

            {/* Navigation */}
            <nav class="hidden md:flex space-x-4">
              {navItems.map((item) => (
                <Link
                  key={item.path}
                  href={item.path}
                  class={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    location === item.path
                      ? "bg-[var(--bg-header-active)] text-white"
                      : "text-white/80 hover:bg-[var(--bg-header-hover)] hover:text-white"
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            {/* Status indicators */}
            <div class="flex items-center space-x-4">
              {/* Theme toggle */}
              <button
                onClick={toggleTheme}
                class="p-2 rounded-md hover:bg-[var(--bg-header-hover)] transition-colors"
                title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              >
                {theme === "dark" ? (
                  <Sun class="w-5 h-5 text-yellow-300" />
                ) : (
                  <Moon class="w-5 h-5 text-white/80" />
                )}
              </button>

              {/* Device status */}
              <div class="flex items-center space-x-2">
                <div
                  class={`w-3 h-3 rounded-full ${
                    deviceConnected ? "bg-green-400" : "bg-red-400"
                  }`}
                  title={deviceConnected ? "Device connected" : "Device disconnected"}
                />
                <span class="text-sm text-white/70">
                  {deviceConnected ? "Connected" : "Offline"}
                </span>
              </div>

              {/* Weight display */}
              {currentWeight !== null && (
                <div class="bg-[var(--bg-header-active)] px-3 py-1 rounded-md">
                  <span class="text-sm font-mono">{currentWeight.toFixed(1)}g</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Mobile navigation */}
      <nav class="md:hidden bg-[var(--bg-header-hover)] border-t border-[var(--border-color)]">
        <div class="flex justify-around">
          {navItems.map((item) => (
            <Link
              key={item.path}
              href={item.path}
              class={`flex flex-col items-center py-2 px-3 text-xs ${
                location === item.path
                  ? "text-white"
                  : "text-white/70"
              }`}
            >
              <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={item.icon} />
              </svg>
              <span class="mt-1">{item.label}</span>
            </Link>
          ))}
        </div>
      </nav>

      {/* Main content */}
      <main class="flex-1">
        <div class={`py-6 px-4 sm:px-6 lg:px-8 mx-auto ${
          location === "/inventory" ? "w-full" : "max-w-7xl w-full"
        }`}>
          {children}
        </div>
      </main>

      {/* Footer */}
      <footer class="bg-[var(--bg-tertiary)] text-[var(--text-muted)] py-4 border-t border-[var(--border-color)]">
        <div class="w-full px-4 sm:px-6 lg:px-8 text-center text-sm">
          SpoolBuddy &bull;{" "}
          <a
            href="https://github.com/maziggy/spoolbuddy"
            target="_blank"
            rel="noopener noreferrer"
            class="text-[var(--accent-color)] hover:text-[var(--accent-hover)]"
          >
            GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
