import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CareerView } from "./components/CareerView";
import { ChatView } from "./components/ChatView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Composer } from "./components/Composer";
import { ControlPanel } from "./components/ControlPanel";
import { Header } from "./components/Header";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { ConfirmProvider } from "./components/ui/Dialog";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { CareerProvider } from "./state/career";
import { ChatProvider, useChat } from "./state/chat";
import { ConversationsProvider, useConversations } from "./state/conversations";
import { DraftProvider } from "./state/draft";
import { ServerProvider } from "./state/server";
import { SettingsProvider, useSettings } from "./state/settings";
import { ToastProvider, useToast } from "./state/toast";
import "./App.css";

// Breakpoints: sidebar is inline from 1024px, the generation panel from 1280px.
const DESKTOP = "(min-width: 1024px)";
const WIDE = "(min-width: 1280px)";

// Memoized without props: the chat view subscribes to conversations itself, so the composer doesn't
// re-render on every streamed frame when MainContent does.
const ChatMain = memo(function ChatMain() {
  return (
    <>
      <ChatView />
      <Composer />
    </>
  );
});

/** Chat, or the Career Guidance Factory (its form, or a roadmap conversation). */
function MainContent() {
  const { active, careerForm } = useConversations();
  return careerForm || active?.kind === "career" ? <CareerView /> : <ChatMain />;
}

function Shell() {
  const isDesktop = useMediaQuery(DESKTOP);
  const isWide = useMediaQuery(WIDE);
  const { settings, update } = useSettings();
  const { newChat } = useChat();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const collapsed = isDesktop && settings.sidebarCollapsed;
  const sidebarMode = !isDesktop ? "drawer" : collapsed ? "rail" : "expanded";
  const panelOverlay = !isWide;

  const toggleSidebar = useCallback(() => {
    if (isDesktop) update({ sidebarCollapsed: !settings.sidebarCollapsed });
    else setDrawerOpen((o) => !o);
  }, [isDesktop, settings.sidebarCollapsed, update]);

  const openSearch = useCallback(() => {
    if (isDesktop) update({ sidebarCollapsed: false });
    else setDrawerOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [isDesktop, update]);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  useEffect(() => {
    if (isDesktop) setDrawerOpen(false);
  }, [isDesktop]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && e.shiftKey && key === "o") {
        e.preventDefault();
        newChat();
        setDrawerOpen(false);
      } else if (mod && !e.shiftKey && key === "k") {
        e.preventDefault();
        openSearch();
      } else if (mod && !e.shiftKey && key === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && key === ".") {
        e.preventDefault();
        setPanelOpen((o) => !o);
      } else if (e.key === "Escape" && !e.defaultPrevented && !settingsOpen) {
        if (drawerOpen) setDrawerOpen(false);
        else if (panelOpen && panelOverlay) setPanelOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, openSearch, toggleSidebar, drawerOpen, panelOpen, panelOverlay, settingsOpen]);

  const showBackdrop = (sidebarMode === "drawer" && drawerOpen) || (panelOverlay && panelOpen);

  return (
    <div className="app">
      <a href="#composer" className="skip-link">
        Skip to message input
      </a>
      <Sidebar
        mode={sidebarMode}
        open={sidebarMode !== "drawer" || drawerOpen}
        onToggle={toggleSidebar}
        onNavigate={closeDrawer}
        onOpenSettings={() => {
          setDrawerOpen(false);
          setSettingsOpen(true);
        }}
        onSearch={openSearch}
        searchRef={searchRef}
      />
      <main className="workspace">
        <Header showSidebarButton={!isDesktop} onOpenSidebar={() => setDrawerOpen(true)} panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((o) => !o)} />
        <MainContent />
      </main>
      <ControlPanel open={panelOpen} overlay={panelOverlay} onClose={() => setPanelOpen(false)} />
      <div
        className={`backdrop${showBackdrop ? " is-visible" : ""}`}
        aria-hidden="true"
        onClick={() => {
          setDrawerOpen(false);
          setPanelOpen(false);
        }}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function WithConversations({ children }: { children: ReactNode }) {
  const toast = useToast();
  const onPersistError = useCallback(() => toast("Couldn't save chats: browser storage is full or blocked.", "error"), [toast]);
  return <ConversationsProvider onPersistError={onPersistError}>{children}</ConversationsProvider>;
}


function CrashScreen() {
  return (
    <div className="crash" role="alert">
      <h1>Something went wrong</h1>
      <p>Prometheus hit an unexpected error. Your chats are saved in this browser.</p>
      <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary fallback={() => <CrashScreen />}>
      <SettingsProvider>
        <ToastProvider>
          <ConfirmProvider>
            {/* Public demo: the workspace opens directly, no sign-in. */}
            <ServerProvider>
              <WithConversations>
                <DraftProvider>
                  <ChatProvider>
                    <CareerProvider>
                      <Shell />
                    </CareerProvider>
                  </ChatProvider>
                </DraftProvider>
              </WithConversations>
            </ServerProvider>
          </ConfirmProvider>
        </ToastProvider>
      </SettingsProvider>
    </ErrorBoundary>
  );
}
