import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { trpc } from "./lib/trpc";
import { isWorldReplaced } from "./lib/worldIdentity";
import { SetupWizard } from "./components/setup/SetupWizard";
import { TopBar } from "./components/ui/TopBar";
import { ActivityFeed } from "./components/ui/ActivityFeed";
import { AgentPanel } from "./components/ui/AgentPanel";
import { ConversationPanel } from "./components/ui/ConversationPanel";
import { ResizeHandle } from "./components/ui/ResizeHandle";
import { GameCanvas } from "./components/canvas/GameCanvas";
import { AgentTooltip } from "./components/overlays/AgentTooltip";
import { DramaAlerts } from "./components/overlays/DramaAlerts";
import { DirectorCaption, DirectorChip } from "./components/overlays/DirectorCaption";
import { useDirector } from "./hooks/useDirector";
import { useSpotlight } from "./hooks/useSpotlight";
import { pushToast } from "./lib/toast";
import { audio } from "./lib/audio/engine";
import { useDramaAlerts } from "./hooks/useDramaAlerts";
import { useGoalWatcher } from "./hooks/useChallenges";
import { NudgeMenu } from "./components/overlays/NudgeMenu";
import { EventMenu } from "./components/ui/EventMenu";
import { TownStats } from "./components/ui/TownStats";
import { useGazette } from "./hooks/useGazette";
import { NewAgentDialog } from "./components/ui/NewAgentDialog";
import { LocationPanel } from "./components/ui/LocationPanel";
import { RelationshipGraph } from "./components/ui/RelationshipGraph";
import { PairDossier } from "./components/ui/PairDossier";
import { RomanceLedger } from "./components/ui/RomanceLedger";
import { Journal } from "./components/ui/Journal";
import { journalUnread, type JournalTab } from "./lib/journal";
import { useWorldState } from "./hooks/useWorldState";
import { gameMinutes } from "../server/lib/gameClock";
import { useAgents } from "./hooks/useAgents";
import { useConversations } from "./hooks/useConversations";
import { useNudge } from "./hooks/useNudge";
import { useKeyboardControls } from "./hooks/useKeyboardControls";
import { loadDirectorOn, saveDirectorOn } from "./lib/directorPref";
import { useFavorites } from "./hooks/useFavorites";
import { useWatchedPairs } from "./hooks/useWatchedPairs";
import { worldSeedOf, orderCast, cycleAgentId } from "./lib/favorites";
import { CastBar } from "./components/ui/CastBar";
import { HealthBanner } from "./components/ui/HealthBanner";
import { Toasts } from "./components/ui/Toasts";
import { LoadingScreen } from "./components/ui/LoadingScreen";
import { FloatingToolbar } from "./components/ui/FloatingToolbar";
import { AutoplayPanel } from "./components/ui/AutoplayPanel";
import { MeetTheTown } from "./components/ui/MeetTheTown";
import { CoachMarks } from "./components/ui/CoachMarks";
import { HelpOverlay } from "./components/ui/HelpOverlay";
import { useFirstRunGuide } from "./hooks/useFirstRunGuide";
import { worldSeedKey } from "./lib/firstRun";
import { useToolbarCollapsed } from "./hooks/useToolbarCollapsed";
import { useCinematic } from "./hooks/useCinematic";
import { FadeToBlack } from "./components/ui/FadeToBlack";
import { toolbarClearance } from "./lib/toolbarLayout";
import { useRecap } from "./hooks/useRecap";
import { RecapCard } from "./components/ui/RecapCard";
import { recapAutoDismissMs, recapVisible } from "./lib/recapDisplay";
import { conversationOf, thoughtOf } from "./lib/thoughtLine";
import { portraitMood } from "./components/ui/portraitMood";

export default function App() {
  const { world, events, isLoading: worldLoading } = useWorldState();
  const { agents } = useAgents();
  const { conversations } = useConversations();
  const nudge = useNudge();
  const utils = trpc.useUtils();
  const { data: locations } = trpc.locations.getAll.useQuery();
  const { data: allRelationships } = trpc.relationships.getGraph.useQuery();

  const [setupComplete, setSetupComplete] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null); // string representation of numeric ID
  const [focusNonce, setFocusNonce] = useState(0);
  // Camera lock requests for GameCanvas (cast bar double-click, F key).
  const [followRequest, setFollowRequest] = useState<{ nonce: number; mode: "start" | "toggle" } | null>(null);
  // The building/open area whose LocationPanel is open (canvas click).
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);
  const [showEventMenu, setShowEventMenu] = useState(false);
  const [showTownStats, setShowTownStats] = useState(false);
  // The Town Journal (paper, inbox, brewing, stories, timeline, talks): the tab
  // showing, or null when closed. Every story surface opens it on its own tab.
  const [journalTab, setJournalTab] = useState<JournalTab | null>(null);
  // Where the Journal reopens when nothing is unread: wherever it was left.
  const lastJournalTab = useRef<JournalTab>("brewing");
  const gazette = useGazette(journalTab === "paper");
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showRelGraph, setShowRelGraph] = useState(false);
  // The Hearts ledger (couples, lovers, longing, crushes, scandals). Painted after the graph, below the dossier.
  const [showHearts, setShowHearts] = useState(false);
  // The pair whose dossier is open (numeric ids). Opened from the graph, the agent
  // panel's relationship rows and the nudge menu; stacks above all of them.
  const [pairDossier, setPairDossier] = useState<{ a: number; b: number } | null>(null);
  const [showAutoplay, setShowAutoplay] = useState(false);
  // Director mode defaults ON (persisted): a new player should see the best scene, not a static map.
  // Player camera input pauses it for 20 s (useDirector), so taking the wheel still works.
  const [autoCut, setAutoCut] = useState(loadDirectorOn);
  const toggleAutoCut = useCallback(() => {
    setAutoCut((v) => {
      saveDirectorOn(!v);
      return !v;
    });
  }, []);

  // Reset all UI state when world returns to wizard state (after resetToWizard)
  // `resetToWizard` is the only thing that nulls `setup_config`, so that is what
  // actually distinguishes "no world yet" from a live one. Keying on
  // `totalTicks === 0 && is_paused` instead meant pausing inside the first
  // second of a fresh simulation threw the user back into the wizard on top of
  // a fully seeded world.
  const isNewSimulation = Boolean(world) && world?.setup_config == null;
  useEffect(() => {
    if (isNewSimulation) {
      setSetupComplete(false);
      setSelectedAgentId(null);
      setSelectedLocationId(null);
      setShowEventMenu(false);
      setShowTownStats(false);
      setJournalTab(null);
      setShowNewAgent(false);
      setShowRelGraph(false);
      setShowHearts(false);
      setPairDossier(null);
      setShowAutoplay(false);
    }
  }, [isNewSimulation]);

  const { collapsed: toolbarCollapsed, toggle: toggleToolbar } = useToolbarCollapsed();
  // "Cinematic moments": whether the screen fades out on a watched couple's night (FadeToBlack).
  const cinematic = useCinematic();

  // Resizable panel sizes. Starting sizes shrink on small windows (the sidebars
  // were 280 + 300 of a 1024 window, leaving a ~350px map); the handles still
  // stretch them. Read once: a window resized later keeps whatever the player set.
  const [leftWidth, setLeftWidth] = useState(() => (window.innerWidth < 1200 ? 220 : 280));
  const [rightWidth, setRightWidth] = useState(() => (window.innerWidth < 1200 ? 260 : 300));
  const [bottomHeight, setBottomHeight] = useState(() => (window.innerHeight < 700 ? 96 : 120));

  const handleLeftResize = useCallback((delta: number) => {
    setLeftWidth(w => Math.max(40, Math.min(500, w + delta)));
  }, []);
  const handleRightResize = useCallback((delta: number) => {
    setRightWidth(w => Math.max(40, Math.min(500, w - delta)));
  }, []);
  const handleBottomResize = useCallback((delta: number) => {
    setBottomHeight(h => Math.max(24, Math.min(400, h - delta)));
  }, []);

  // Tooltip state. Only the id is kept: the card is derived from the live `agents` query on every
  // render (see `tooltip` below), so it follows the resident while the pointer rests on them
  // instead of freezing the action and thought seen at the moment the hover began.
  const [hoveredAgentId, setHoveredAgentId] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  // Context menu state
  const [contextMenuAgent, setContextMenuAgent] = useState<string | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);

  // A world replace (TopBar Restart, a Restart from another tab, a reseed script)
  // is announced on the dirty channels, but those only invalidate the queries
  // each hook is wired to. `locations.getAll` is on no channel at all, so the old
  // town's buildings stayed on the map until a page reload, and every other
  // unwired query kept describing the old world. Agent ids restart at 1, so a
  // selected id silently re-points at a different townsperson — drop it.
  //
  // The clock check can't see a replace of a world still at totalTicks 0
  // (restart while paused at the start), so TopBar also calls
  // `handleWorldReplaced` directly for the replaces this tab asked for.
  // Cast bar: favourites are per world (keyed by seed) and sort first, both in the
  // bar and in Tab order, so the two never disagree about who is "next".
  const worldSeed = worldSeedOf(world?.setup_config);
  const { favorites, toggleFavorite } = useFavorites(worldSeed);
  // Pairs the player follows (PairDossier's Watch button): alert on the pair's
  // story, not on everything each of them does.
  const { watchedPairs, toggleWatchedPair, isWatched } = useWatchedPairs(worldSeed);
  // Alert toasts + the inbox. Here rather than inside the toast overlay: the
  // TopBar's Journal badge and the Journal's Inbox tab read the same state. Favourites' rows
  // alert at a lower bar (server/lib/alertTiers.ts).
  const drama = useDramaAlerts(worldSeed, favorites, watchedPairs);
  const resetAlerts = drama.reset;
  // Challenge fanfares on the canvas and the cross-world achievements, from the
  // activity rows the canvas already polls (hooks/useChallenges.ts).
  useGoalWatcher(Boolean(world) && !isNewSimulation);

  // Deep link into the Journal. With no tab named (TopBar 📖, J) it opens where
  // the news is: unread alerts first, then a new paper, else the tab it was left on.
  const unreadAlerts = drama.unread;
  const hasNewPaper = gazette.hasNew;
  const openJournal = useCallback((tab?: JournalTab) => {
    const next = tab ?? (unreadAlerts > 0 ? "inbox" : hasNewPaper ? "paper" : lastJournalTab.current);
    lastJournalTab.current = next;
    setJournalTab(next);
  }, [unreadAlerts, hasNewPaper]);
  const closeJournal = useCallback(() => setJournalTab(null), []);
  const toggleJournal = useCallback(() => {
    if (journalTab) closeJournal();
    else openJournal();
  }, [journalTab, closeJournal, openJournal]);

  const handleWorldReplaced = useCallback(() => {
    setSelectedAgentId(null);
    setSelectedLocationId(null);
    setContextMenuAgent(null);
    setContextMenuPos(null);
    // Agent ids restart at 1 in a new world, so a dossier would silently show two strangers.
    setPairDossier(null);
    // Old alerts name the old world's residents by ids that now belong to others.
    resetAlerts();
  }, [resetAlerts]);
  const totalTicks = world?.time?.totalTicks ?? null;
  const lastTotalTicksRef = useRef<number | null>(null);
  useEffect(() => {
    if (isWorldReplaced(lastTotalTicksRef.current, totalTicks)) {
      utils.invalidate();
      handleWorldReplaced();
    }
    // A momentary null (no world row mid-reset) must not erase the last known
    // clock, or the drop that follows it would go unnoticed.
    if (totalTicks != null) lastTotalTicksRef.current = totalTicks;
  }, [totalTicks, utils, handleWorldReplaced]);

  // "Previously on…" after a gap of 6+ game hours or when a night skip ends
  // (useRecap decides when, RecapCard shows it).
  const recap = useRecap({
    worldKey: worldSeedKey(world?.setup_config),
    nowMinute: world?.time ? gameMinutes(world.time) : null,
    ready: Boolean(world) && !worldLoading && !(isNewSimulation && !setupComplete) && agents.length > 0,
  });
  const recapOpen = recap.request != null;
  const dismissRecap = recap.dismiss;

  // Close modals on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (pairDossier) {
          // Painted last (z-50), over the graph it is usually opened from.
          setPairDossier(null);
        } else if (contextMenuAgent) {
          setContextMenuAgent(null);
          setContextMenuPos(null);
        } else if (showEventMenu) {
          setShowEventMenu(false);
        } else if (showTownStats) {
          setShowTownStats(false);
        } else if (showNewAgent) {
          setShowNewAgent(false);
        } else if (showAutoplay) {
          setShowAutoplay(false);
        } else if (journalTab) {
          // Escape closes the topmost layer, so this chain must match paint
          // order: the Journal is rendered after the graph and covers it.
          setJournalTab(null);
        } else if (showHearts) {
          // Rendered after the graph, so it is painted over it.
          setShowHearts(false);
        } else if (showRelGraph) {
          setShowRelGraph(false);
        } else if (recapOpen) {
          // A card on the map: under every modal, over the side panels' content.
          dismissRecap();
        } else if (selectedLocationId != null) {
          // The location card floats over the map, so it is above the agent panel.
          setSelectedLocationId(null);
        } else if (selectedAgentId) {
          setSelectedAgentId(null);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [pairDossier, contextMenuAgent, showEventMenu, showTownStats, showNewAgent, showRelGraph, showHearts, journalTab, recapOpen, dismissRecap, showAutoplay, selectedLocationId, selectedAgentId]);

  const cast = useMemo(() => orderCast(agents, favorites), [agents, favorites]);

  const openPair = useCallback((a: string, b: string) => setPairDossier({ a: Number(a), b: Number(b) }), []);

  // Select an agent AND re-center on them, even if they were already selected.
  // The `Raw` pair is what the Director uses for its own cuts; the player-facing
  // `focusAgent` / `followAgent` below also tell the Director the player has the
  // camera, or every one of its cuts would pause itself.
  const focusAgentRaw = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
    setFocusNonce(n => n + 1);
  }, []);

  // Focus plus lock the camera on them (GameCanvas applies the lock after the
  // selection change it would otherwise clear).
  const followAgentRaw = useCallback((agentId: string) => {
    focusAgentRaw(agentId);
    setFollowRequest(r => ({ nonce: (r?.nonce ?? 0) + 1, mode: "start" }));
  }, [focusAgentRaw]);

  // Director mode (toolbar 🎬): scores the town every few seconds and cuts the
  // camera to the best scene; captions the conversation on screen.
  const director = useDirector({
    enabled: autoCut,
    agents,
    conversations: conversations ?? [],
    locations: locations ?? [],
    events: events ?? [],
    alerts: drama.alerts,
    favorites,
    followAgent: followAgentRaw,
  });
  // Who is on screen → the server spends its LLM slots there first.
  useSpotlight({ selectedAgentId, favorites, shot: director.shot, agents });
  const noteDirectorInput = director.notePlayerInput;

  const focusAgent = useCallback((agentId: string) => {
    noteDirectorInput();
    focusAgentRaw(agentId);
  }, [noteDirectorInput, focusAgentRaw]);

  const followAgent = useCallback((agentId: string) => {
    noteDirectorInput();
    followAgentRaw(agentId);
  }, [noteDirectorInput, followAgentRaw]);

  // Clicking a resident on the map selects and re-centers them: camera input too.
  const handleCanvasAgentSelect = useCallback((agentId: string) => {
    noteDirectorInput();
    setSelectedAgentId(agentId);
  }, [noteDirectorInput]);

  // D: the keyboard twin of the toolbar's 🎬 button. Says which way it went, since
  // the camera switching itself is easy to miss.
  const handleToggleDirector = useCallback(() => {
    toggleAutoCut();
    pushToast(autoCut ? "Director off" : "Director on", "info", "🎬");
  }, [toggleAutoCut, autoCut]);

  const toggleCaptions = director.toggleCaptions;
  const handleToggleCaptions = useCallback(() => {
    const on = toggleCaptions();
    pushToast(
      on ? (autoCut ? "Captions on" : "Captions on (they show while the Director is on)") : "Captions off",
      "info",
      "💬",
    );
  }, [toggleCaptions, autoCut]);
  // First-run guide (Meet the town -> coach marks), once per world seed, and the "?" help.
  const guide = useFirstRunGuide({
    worldKey: worldSeedKey(world?.setup_config),
    ready: Boolean(world) && !worldLoading && !(isNewSimulation && !setupComplete) && agents.length > 0,
  });

  // Every overlay but the Journal: while one is open the resident keys stand
  // down, and J doesn't stack the Journal on top of it.
  const otherOverlayOpen = Boolean(
    contextMenuAgent || showEventMenu || showTownStats || showNewAgent || showRelGraph || showHearts || pairDossier ||
    showAutoplay || guide.tourOpen || guide.helpOpen,
  );

  // Keyboard controls
  useKeyboardControls({
    // The wizard and loading screen render before the sim exists; Space there
    // would unpause an unseeded world and drop the user into the main UI.
    enabled: Boolean(world) && !worldLoading && !(isNewSimulation && !setupComplete),
    isPaused: Boolean(world?.is_paused),
    onTogglePause: () => nudge.togglePause(),
    onChangeSpeed: (speed: number) => nudge.changeSpeed(speed),
    onCycleAgent: (direction) => {
      const next = cycleAgentId(cast.map((a) => String(a.id)), selectedAgentId, direction);
      if (next) focusAgent(next);
    },
    onToggleFollow: () => {
      if (!selectedAgentId) return;
      noteDirectorInput();
      setFollowRequest(r => ({ nonce: (r?.nonce ?? 0) + 1, mode: "toggle" }));
    },
    onToggleCaptions: handleToggleCaptions,
    onToggleDirector: handleToggleDirector,
    onToggleMute: () => {
      audio.toggleMute();
      return audio.getSettings().muted;
    },
    agentKeysEnabled: !otherOverlayOpen && journalTab == null,
    onToggleHelp: guide.toggleHelp,
    onToggleJournal: toggleJournal,
    journalKeyEnabled: !otherOverlayOpen,
  });

  // Canvas callbacks
  const handleAgentHover = useCallback(
    (agentId: string | null, pos?: { x: number; y: number }) => {
      if (!agentId || !pos) {
        setHoveredAgentId(null);
        setHoverPos(null);
        return;
      }
      setHoveredAgentId(agentId);
      setHoverPos(pos);
    },
    []
  );

  const tooltip = useMemo(() => {
    const agent = hoveredAgentId == null ? undefined : agents.find((a) => String(a.id) === hoveredAgentId);
    if (!agent) return null;
    // The building the agent is in, so "working" can say where.
    const place = locations?.find((l) => l.id === agent.current_location)?.name ?? null;
    const nameById = new Map(agents.map((a) => [a.id, a.name]));
    const states = agent.activeStates ?? [];
    const thought = thoughtOf(agent, {
      nameOf: (id) => nameById.get(id),
      conversation: conversationOf(agent.id, conversations),
    });
    return {
      agent: {
        name: agent.name,
        currentAction: agent.current_action,
        place,
        portrait_sprite: agent.portrait_sprite,
        gender: agent.gender,
        age: agent.age,
      },
      thought,
      mood: portraitMood(agent.needs?.mood, states),
    };
  }, [hoveredAgentId, agents, locations, conversations]);

  const handleAgentContextMenu = useCallback(
    (agentId: string, pos: { x: number; y: number }) => {
      setContextMenuAgent(agentId);
      setContextMenuPos(pos);
      // Clear tooltip when context menu opens
      setHoveredAgentId(null);
      setHoverPos(null);
    },
    []
  );

  const handleCloseContextMenu = useCallback(() => {
    setContextMenuAgent(null);
    setContextMenuPos(null);
  }, []);

  const selectedLocation =
    selectedLocationId != null
      ? ((locations ?? []).find((l) => l.id === selectedLocationId) ?? null)
      : null;

  // Show setup wizard if simulation hasn't started
  if (isNewSimulation && !setupComplete) {
    return <SetupWizard onStart={() => {
      utils.invalidate(); // refetch all queries after seed
      setSetupComplete(true);
    }} />;
  }

  if (worldLoading || !world) {
    return <LoadingScreen />;
  }

  return (
    <div className="h-screen w-screen bg-ui-deep text-ui-text flex flex-col overflow-hidden">
      <TopBar
        world={world}
        events={events ?? []}
        liveConversations={conversations?.length ?? 0}
        awakeAgents={agents.filter((a) => {
          const t = (a as { current_action?: { type?: string } }).current_action?.type;
          return t !== 'sleeping' && t !== 'dead';
        }).length}
        onShowEvents={() => setShowEventMenu(true)}
        onShowStats={() => setShowTownStats(true)}
        onShowJournal={() => openJournal()}
        journalUnread={journalUnread({ unreadAlerts: drama.unread, hasNewPaper: gazette.hasNew })}
        hasNewPaper={gazette.hasNew}
        onWorldReplaced={handleWorldReplaced}
      />
      {/* Socket down / LLM offline or slow / ticks lagging (renders nothing when fine) */}
      <HealthBanner />
      <CastBar
        agents={cast}
        locations={locations ?? []}
        conversations={conversations ?? []}
        selectedAgentId={selectedAgentId}
        favorites={favorites}
        onToggleFavorite={toggleFavorite}
        onFocus={focusAgent}
        onFollow={followAgent}
        onContextMenu={handleAgentContextMenu}
      />
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Conversations sidebar */}
        <div style={{ width: leftWidth }} className="flex-shrink-0 overflow-hidden">
          <ConversationPanel onSelectAgent={focusAgent} />
        </div>
        <ResizeHandle direction="horizontal" onResize={handleLeftResize} />
        {/* PixiJS game canvas, with the Director's overlays layered on top of it
            (inside this box, so they follow the map when the side panels resize) */}
        <div className="flex-1 min-w-0 h-full relative flex">
          <GameCanvas
            agents={agents}
            world={world}
            events={events}
            conversations={conversations ?? []}
            locations={locations ?? []}
            relationships={allRelationships ?? []}
            onAgentSelect={handleCanvasAgentSelect}
            onAgentContextMenu={handleAgentContextMenu}
            onAgentHover={handleAgentHover}
            onLocationSelect={setSelectedLocationId}
            selectedLocationId={selectedLocationId}
            selectedAgentId={selectedAgentId}
            focusNonce={focusNonce}
            followRequest={followRequest}
            onUserCameraInput={noteDirectorInput}
          />
          <DirectorCaption caption={director.caption} cut={director.cut} rightClearance={toolbarClearance(toolbarCollapsed)} />
          <DirectorChip paused={director.paused} onResume={director.resume} />
          {/* Drama alerts (the Director decides which of them the camera cuts to) */}
          <DramaAlerts alerts={drama.alerts} dismiss={drama.dismiss} onFocusAgent={focusAgent} />
          {/* "Previously on…" / "Overnight…" (bottom-left, clear of the tools strip) */}
          <RecapCard
            request={recap.request}
            agents={agents}
            onFocusAgent={focusAgent}
            onOpenJournal={() => {
              dismissRecap();
              openJournal("timeline");
            }}
            onDismiss={dismissRecap}
            autoDismissMs={recapAutoDismissMs(autoCut)}
            hidden={!recapVisible({ directorOn: autoCut, captionShown: director.caption != null })}
          />
          {/* Tools strip: bottom-right of the map, folds into an icon rail */}
          <FloatingToolbar
            onNewAgent={() => setShowNewAgent(true)}
            onShowRelationships={() => setShowRelGraph(true)}
            onShowHearts={() => setShowHearts(true)}
            onShowAutoplay={() => setShowAutoplay(true)}
            autoCut={autoCut}
            onToggleAutoCut={toggleAutoCut}
            cinematic={cinematic.enabled}
            onToggleCinematic={cinematic.toggle}
            onMeetTheTown={guide.openTour}
            onShowHelp={guide.openHelp}
            collapsed={toolbarCollapsed}
            onToggleCollapsed={toggleToolbar}
          />
        </div>
        {/* AgentPanel sidebar */}
        {selectedAgentId && (
          <>
            <ResizeHandle direction="horizontal" onResize={handleRightResize} />
            <div style={{ width: rightWidth }} className="flex-shrink-0 overflow-hidden">
              <AgentPanel
                agentId={selectedAgentId}
                onClose={() => setSelectedAgentId(null)}
                onSelectAgent={focusAgent}
                onViewPair={openPair}
              />
            </div>
          </>
        )}
      </div>
      <ResizeHandle direction="vertical" onResize={handleBottomResize} />
      <div style={{ height: bottomHeight }} className="flex-shrink-0 overflow-hidden">
        <ActivityFeed onSelectAgent={focusAgent} onOpenBrewing={() => openJournal("brewing")} />
      </div>

      {/* Clicked building / open area */}
      {selectedLocation && (
        <LocationPanel
          location={selectedLocation}
          agents={agents}
          events={events ?? []}
          hour={world?.time?.hour ?? null}
          nowMinutes={world?.time ? gameMinutes(world.time) : null}
          selectedAgentId={selectedAgentId}
          onSelectAgent={focusAgent}
          onClose={() => setSelectedLocationId(null)}
          left={leftWidth + 24}
        />
      )}

      {/* The camera looks away when a watched couple spends the night together */}
      <FadeToBlack
        enabled={!(isNewSimulation && !setupComplete)}
        cinematic={cinematic.enabled}
        selectedAgentId={selectedAgentId}
        favorites={favorites}
      />

      {/* Acknowledgements for player actions (lib/toast.ts) */}
      <Toasts />

      {/* Tooltip overlay */}
      <AgentTooltip agent={tooltip?.agent ?? null} thought={tooltip?.thought} mood={tooltip?.mood} position={hoverPos} />

      {/* Context menu */}
      {contextMenuAgent && contextMenuPos && (
        <NudgeMenu
          agentId={contextMenuAgent}
          selectedAgentId={selectedAgentId}
          position={contextMenuPos}
          agents={agents}
          locations={locations ?? []}
          onClose={handleCloseContextMenu}
          onSelectAgent={(id) => {
            setSelectedAgentId(id);
            handleCloseContextMenu();
          }}
          onViewPair={openPair}
        />
      )}

      {/* Modals */}
      <EventMenu
        isOpen={showEventMenu}
        onClose={() => setShowEventMenu(false)}
        activeEvents={events ?? []}
        nowMinutes={world?.time ? gameMinutes(world.time) : null}
      />
      <TownStats
        isOpen={showTownStats}
        onClose={() => setShowTownStats(false)}
      />
      <NewAgentDialog
        isOpen={showNewAgent}
        onClose={() => setShowNewAgent(false)}
        onCreated={(id) => focusAgent(String(id))}
      />
      <RelationshipGraph
        isOpen={showRelGraph}
        onClose={() => setShowRelGraph(false)}
        onSelectAgent={(id) => {
          setSelectedAgentId(id);
          setShowRelGraph(false);
        }}
        onViewPair={openPair}
      />
      <RomanceLedger
        isOpen={showHearts}
        onClose={() => setShowHearts(false)}
        onViewPair={openPair}
        onSelectAgent={(id) => {
          setSelectedAgentId(id);
          setShowHearts(false);
        }}
      />
      <Journal
        tab={journalTab}
        onTabChange={openJournal}
        onClose={closeJournal}
        onSelectAgent={(id) => {
          // Close first: the Journal covers the map, so the camera move would
          // otherwise happen behind it.
          closeJournal();
          focusAgent(id);
        }}
        inbox={{ entries: drama.inbox, unread: drama.unread, markAllRead: drama.markAllRead, clear: drama.clearInbox }}
        hasNewPaper={gazette.hasNew}
        agents={agents}
      />
      <AutoplayPanel isOpen={showAutoplay} onClose={() => setShowAutoplay(false)} />
      <PairDossier
        pair={pairDossier}
        watched={pairDossier ? isWatched(pairDossier.a, pairDossier.b) : false}
        onToggleWatch={() => { if (pairDossier) toggleWatchedPair(pairDossier.a, pairDossier.b); }}
        onClose={() => setPairDossier(null)}
        onFocusAgent={(id) => {
          // The dossier and the graph under it cover the map, so the camera move
          // would otherwise happen behind them.
          setPairDossier(null);
          setShowRelGraph(false);
          setShowHearts(false);
          focusAgent(id);
        }}
      />

      {/* First-run guide + help: they take Escape themselves (useEscapeClose). */}
      <MeetTheTown
        isOpen={guide.tourOpen}
        replay={guide.tourIsReplay}
        onClose={guide.closeTour}
        agents={agents}
        onSelectAgent={focusAgent}
      />
      <CoachMarks isOpen={guide.coachOpen} onClose={guide.closeCoach} />
      <HelpOverlay isOpen={guide.helpOpen} onClose={guide.closeHelp} onMeetTheTown={guide.openTour} />

      {/* Attribution */}
      <div className="fixed bottom-1 left-1 z-10 text-[8px] text-ui-muted opacity-40 pointer-events-none">
        Art: LimeZu (CC-BY 4.0)
      </div>
    </div>
  );
}
