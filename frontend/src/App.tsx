import { Route, Switch } from "wouter-preact";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Inventory } from "./pages/Inventory";
import { SpoolDetail } from "./pages/SpoolDetail";
import { Printers } from "./pages/Printers";
import { Settings } from "./pages/Settings";
import { WebSocketProvider } from "./lib/websocket";
import { ThemeProvider } from "./lib/theme";
import { ToastProvider } from "./lib/toast";

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <WebSocketProvider>
          <Layout>
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/inventory" component={Inventory} />
            <Route path="/spool/:id" component={SpoolDetail} />
            <Route path="/printers" component={Printers} />
            <Route path="/settings" component={Settings} />
            <Route>
              <div class="p-8 text-center">
                <h1 class="text-2xl font-bold text-gray-800">404 - Not Found</h1>
              </div>
            </Route>
          </Switch>
          </Layout>
        </WebSocketProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
