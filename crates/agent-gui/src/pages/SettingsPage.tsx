import { type ReactNode, useEffect, useMemo, useState } from "react";
import { isMacOsTauri, MacOsTitleBarSpacer } from "../components/MacOsTitleBarSpacer";
import {
  ArrowLeft,
  BookOpen,
  Brain,
  Clock3,
  Cloud,
  Cpu,
  Info,
  Settings2,
  Zap,
} from "../components/icons";

import { useLocale } from "../i18n";
import { AboutSection } from "./settings/AboutSection";
import { AgentsSection } from "./settings/AgentsSection";
import { CronSection } from "./settings/CronSection";
import { HooksSection } from "./settings/HooksSection";
import { MemoryPanel } from "./settings/MemoryPanel";
import { ProvidersSection } from "./settings/ProvidersSection";
import { RemoteSection } from "./settings/RemoteSection";
import { SystemSettingsForm } from "./settings/SystemSettingsForm";
import type { SectionId, SettingsPageProps } from "./settings/types";

function getSaveIndicator(state: SettingsPageProps["saveState"], t: (key: string) => string) {
  switch (state.status) {
    case "saving":
      return {
        dotClass: "bg-amber-500 animate-pulse",
        text: t("settings.saving"),
        title: t("settings.savingDesc"),
      };
    case "error":
      return {
        dotClass: "bg-destructive",
        text: t("settings.saveError"),
        title: state.message,
      };
    case "saved":
    case "idle":
    default:
      return {
        dotClass: "bg-emerald-500",
        text: t("settings.saved"),
        title: t("settings.savedDesc"),
      };
  }
}

type NavItemProps = {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
};

function NavItem({ icon, label, active, onClick }: NavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
        active
          ? "bg-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      }`}
    >
      <span className="shrink-0 opacity-70">{icon}</span>
      <span className="leading-none">{label}</span>
    </button>
  );
}

const NAV_ITEMS_STATIC: Array<{ id: SectionId; icon: ReactNode }> = [
  {
    id: "system",
    icon: <Settings2 className="h-3.5 w-3.5" />,
  },
  {
    id: "providers",
    icon: <Cpu className="h-3.5 w-3.5" />,
  },
  {
    id: "agents",
    icon: <BookOpen className="h-3.5 w-3.5" />,
  },
  {
    id: "memory",
    icon: <Brain className="h-3.5 w-3.5" />,
  },
  {
    id: "hooks",
    icon: <Zap className="h-3.5 w-3.5" />,
  },
  {
    id: "cron",
    icon: <Clock3 className="h-3.5 w-3.5" />,
  },
  {
    id: "remote",
    icon: <Cloud className="h-3.5 w-3.5" />,
  },
  {
    id: "about",
    icon: <Info className="h-3.5 w-3.5" />,
  },
];

export function SettingsPage(props: SettingsPageProps) {
  const {
    settings,
    setSettings,
    saveState,
    onBack,
    initialSection = "system",
    hiddenSections = [],
  } = props;
  const { t } = useLocale();
  const [section, setSection] = useState<SectionId>(initialSection);

  const sectionLabels: Record<SectionId, string> = {
    system: t("settings.navSystem"),
    providers: t("settings.navProviders"),
    agents: t("settings.navAgents"),
    memory: t("settings.navMemory"),
    hooks: t("settings.navHooks"),
    cron: t("settings.navCron"),
    remote: t("settings.navRemote"),
    about: t("settings.navAbout"),
  };

  const hiddenSectionSet = useMemo(() => new Set(hiddenSections), [hiddenSections]);
  const navItems = useMemo(
    () =>
      NAV_ITEMS_STATIC.filter((item) => !hiddenSectionSet.has(item.id)).map((item) => ({
        ...item,
        label: sectionLabels[item.id],
      })),
    [hiddenSectionSet, sectionLabels],
  );

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    if (navItems.some((item) => item.id === section)) {
      return;
    }
    setSection(navItems[0]?.id ?? "system");
  }, [navItems, section]);

  const saveIndicator = getSaveIndicator(saveState, t);
  const sectionContent = (() => {
    switch (section) {
      case "providers":
        return <ProvidersSection settings={settings} setSettings={setSettings} />;
      case "system":
        return <SystemSettingsForm settings={settings} setSettings={setSettings} />;
      case "hooks":
        return <HooksSection settings={settings} setSettings={setSettings} />;
      case "cron":
        return <CronSection settings={settings} setSettings={setSettings} />;
      case "agents":
        return <AgentsSection settings={settings} setSettings={setSettings} />;
      case "remote":
        return <RemoteSection settings={settings} setSettings={setSettings} />;
      case "memory":
        return (
          <MemoryPanel
            workdir={settings.system.workdir}
            settings={settings}
            setSettings={setSettings}
          />
        );
      case "about":
        return <AboutSection settings={settings} setSettings={setSettings} />;
      default: {
        const unreachable: never = section;
        return unreachable;
      }
    }
  })();

  const onMac = isMacOsTauri();

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-52 shrink-0 flex-col border-r bg-muted/20">
          {onMac && (
            <div data-tauri-drag-region className="h-[38px] shrink-0" />
          )}
          <div className="px-3 pb-1 pt-3">
            <button
              type="button"
              onClick={onBack}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" />
              <span>{t("settings.backToChat")}</span>
            </button>
          </div>

          <nav className="flex-1 space-y-0.5 px-3 py-2">
            {navItems.map((item) => (
              <NavItem
                key={item.id}
                icon={item.icon}
                label={item.label}
                active={section === item.id}
                onClick={() => setSection(item.id)}
              />
            ))}
          </nav>

          <div className="border-t px-4 py-2.5">
            <div
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              title={saveIndicator.title}
            >
              <div className={`h-1.5 w-1.5 rounded-full ${saveIndicator.dotClass}`} />
              {saveIndicator.text}
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <MacOsTitleBarSpacer />
          <div className="border-b px-6 py-3.5">
            <div key={section} className="settings-section-title-enter text-base font-semibold">
              {sectionLabels[section]}
            </div>
          </div>

          <div
            key={section}
            className={`settings-section-enter flex-1 px-6 py-5 ${
              section === "hooks" || section === "providers" || section === "memory"
                ? "flex min-h-0 flex-col overflow-hidden"
                : "overflow-auto"
            }`}
          >
            <div
              className={`settings-section-shell ${
                section === "hooks" || section === "providers" || section === "memory"
                  ? "flex min-h-0 flex-1 flex-col"
                  : "min-h-full"
              }`}
            >
              {sectionContent}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
