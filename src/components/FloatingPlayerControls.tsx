import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { Play, Pause } from 'lucide-react';
import { MotionValue } from 'framer-motion';
import ProgressBar from './ProgressBar';
import { PlayerState, LyricData, Theme } from '../types';
import LyricsTimelineModal from './modal/LyricsTimelineModal';
import TrackTitleNavigator from './floating-player/TrackTitleNavigator';
import PlayerControlSlotButton from './floating-player/PlayerControlSlotButton';
import PlayerBottomBarPositioner from './floating-player/PlayerBottomBarPositioner';
import PlayerBarGlow from './floating-player/PlayerBarGlow';
import PlayerControlSlotPicker from './floating-player/PlayerControlSlotPicker';
import PlayerControlSlotSuggestion from './floating-player/PlayerControlSlotSuggestion';
import CapsuleQuickActions, { useCapsuleQuickActionsDwell } from './floating-player/CapsuleQuickActions';
import { usePlayerControlSlotCustomization } from './floating-player/usePlayerControlSlotCustomization';
import { usePlayerBottomBarBottomPx } from '../hooks/usePlayerBottomBarBottomPx';
import { playerBottomBarLiveOffset } from '../stores/motionSignals';
import { usePlayerBottomBarLayoutStore } from '../stores/usePlayerBottomBarLayoutStore';
import { usePlayerChromeSettingsStore } from '../stores/usePlayerChromeSettingsStore';
import { openSettings } from '../stores/useSettingsModalStore';
import { PLAYER_BOTTOM_BAR_BASE_OFFSET_PX, clampPlayerBottomBarOffset, resolvePlayerBottomBarMaxOffset } from '../utils/playerBottomBarLayout';
import type { PlayerControlSlotActionId, PlayerControlSlotContext } from './floating-player/playerControlSlotActions';
import { usePlayerOverlayObstacle } from '../hooks/usePlayerOverlayLayout';
import { useSupportsFinePointer } from '../hooks/useSupportsFinePointer';
import { resolvePlayerCapsuleNavigationTarget } from '../hooks/useAppNavigation';
import { useCapsulePaletteStore } from '../stores/useCapsulePaletteStore';
import { openCommandPalette } from '../stores/useAppViewStore';
import { usePlaybackEntryViewStore } from '../stores/usePlaybackEntryViewStore';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { resolveLyricSeekMediaTime } from '../utils/lyrics/lyricSeekTime';
import { HifiProgressRow } from './hifi/HifiBadge';
import { useIsHifiRoute } from './hifi/useHifiSignalPath';
import { useGlass } from '../shinoinject/useGlass.tsx';
import { releaseGlassJelly } from '../shinoinject/liquidglass.ts';

export interface TrackNavigation {
    /** 当前曲目的稳定身份，用于识别「确实换歌了」；相邻两首同名时标题字符串不变，不能拿标题判断 */
    currentTrackKey: string;
    onPrev: () => void;
    onNext: () => void;
    canPrev: boolean;
    canNext: boolean;
    prevTitle: string | null;
    nextTitle: string | null;
    prevLabel: string;
    nextLabel: string;
}

const CONTROL_LAYOUT_SPRING = {
    type: 'spring' as const,
    stiffness: 280,
    damping: 24,
};

/*
 * 页面切换时胶囊的宽高 / 圆角整套变化，走 framer 的 layout 动画，动画期间逐帧改写 inline transform。
 * 果冻会话同样在写 transform（收编 base 后叠加形变），两者同时进行会互相覆盖：
 * 切换那一瞬间按下的拖拽会被 layout 修正吃掉，观感上就是「果冻失效」。
 * 所以切换时先摘掉 data-glass-jelly 并收掉进行中的会话，等动画放完再挂回去。
 *
 * 判定只看 DOM：每帧比一次胶囊的 inline transform，连续静默若干帧即视为落定。不依赖 framer 的
 * 动画回调 —— 尺寸没变时它根本不触发，而单纯用固定超时又会在这段时间里真的没有果冻。
 * 超时只是最后一道保险，防动画被中断后一直挂着。
 */
const JELLY_REARM_QUIET_FRAMES = 6;
const JELLY_REARM_MIN_WAIT_MS = 180;
const JELLY_REARM_MAX_WAIT_MS = 1200;

const HOVER_EXPAND_DELAY_MS = 20;
const HOVER_COLLAPSE_DELAY_MS = 100;
const HOVER_HITBOX_BOTTOM_BUFFER_PX = 32;
/** 手指浮出的那排命令（连同它撑开的胶囊）这么久没碰就收起。 */
const TOUCH_REVEAL_MS = 4000;
/** 手指按下到抬起挪得比这少才算点了一下胶囊，多了是在拖进度条。 */
const TOUCH_TAP_SLOP_PX = 10;
/** 手指点出那排之后，这么久内补发的那一下 click 不算数（见 swallowStrayClick）。 */
const TOUCH_STRAY_CLICK_MS = 400;
/** 鼠标或手指按下到 click 挪得比这多，是拖（多半在拖进度条、拖偏了几像素），不算点胶囊。 */
const CLICK_DRAG_SLOP_PX = 10;
/** 进度条的轨道（ProgressBar 的 progress.track，拖动用的 range 就在里面）。 */
const isOnSeekTrack = (target: EventTarget | null): boolean => (
    target instanceof Element && target.closest('[data-folium-part="progress.track"]') !== null
);
/*
 * 模组可以通过公开变量 --folium-player-bar-extra 加宽胶囊，补回进度条两侧按钮占掉的长度。
 * 外层 max-width 已经加了一份 extra；收起的胶囊是外层的 80% / 60%，所以只再补 (1 - 比例) 份，
 * 外层顶到 max-width 时收起胶囊正好宽出 extra。
 */
const COLLAPSED_WIDTH_CLASS = 'w-[min(100%,calc(80%_+_var(--folium-player-bar-extra,0px)_*_0.2))] md:w-[min(100%,calc(60%_+_var(--folium-player-bar-extra,0px)_*_0.4))]';

/**
 * 槽位上下文里由 App 提供的部分。循环模式、歌词时间轴和上一首/下一首的可用性
 * 胶囊自己已经有了，不让调用方重复传一遍。
 */
export type SlotContextFromApp = Omit<
    PlayerControlSlotContext,
    'loopMode' | 'onToggleLoop' | 'onToggleTimeline' | 'hasLyrics' | 'canPrev' | 'canNext' | 'onPrev' | 'onNext'
>;

interface FloatingPlayerControlsProps {
    currentSong: { name: string; } | null;
    playerState: PlayerState;
    currentTime: MotionValue<number>;
    lyricCurrentTime?: MotionValue<number>;
    duration: number;
    loopMode: 'off' | 'all' | 'one';
    currentView: 'home' | 'player' | 'lattice';
    audioSrc: string | null;
    canTogglePlay?: boolean;
    lyrics: LyricData | null;
    onSeek: (time: number) => void;
    onTogglePlay: () => void;
    onToggleLoop: () => void;
    onNavigateToPlayer: () => void;
    onFocusLatticeCurrentSong?: () => void;
    noTrackText?: string;
    primaryColor?: string;
    secondaryColor?: string;
    theme?: Theme;
    isDaylight: boolean;
    isHidden?: boolean;
    hideControlBar?: boolean;
    controlsDisabled?: boolean;
    trackNavigation?: TrackNavigation | null;
    /** 右侧两个可自定义槽位的动作 id。 */
    slotPrimary: PlayerControlSlotActionId;
    slotSecondary: PlayerControlSlotActionId;
    /** 槽位共用的播放上下文里，胶囊自己能提供的那几项在内部补齐。 */
    slotContext: SlotContextFromApp;
    /** 提交定位结果；由 App 写回持久化设置。 */
    onCommitBottomBarOffset: (offsetPx: number) => void;
}


const FloatingPlayerControls: React.FC<FloatingPlayerControlsProps> = ({
    currentSong,
    playerState,
    currentTime,
    lyricCurrentTime,
    duration,
    loopMode,
    currentView,
    audioSrc,
    canTogglePlay = false,
    lyrics,
    onSeek,
    onTogglePlay,
    onToggleLoop,
    onNavigateToPlayer,
    onFocusLatticeCurrentSong,
    noTrackText = 'No Track',
    primaryColor = 'var(--text-primary)',
    secondaryColor = 'var(--text-secondary)',
    theme,
    isDaylight,
    isHidden: isChromeHidden = false,
    hideControlBar = false,
    controlsDisabled = false,
    trackNavigation = null,
    slotPrimary,
    slotSecondary,
    slotContext,
    onCommitBottomBarOffset,
}) => {
    const { t } = useTranslation();
    const slotCustomization = usePlayerControlSlotCustomization(slotPrimary, slotSecondary);
    const { slotPicker, closeSlotPicker, slotSuggestion } = slotCustomization;
    // 自动隐藏播放页控件只看鼠标移动：盯着更换浮层看选项时不动鼠标，浮层不能跟着整条控制条一起淡出。
    const isHidden = isChromeHidden && slotPicker === null;
    const { ref: layoutRef, invalidate: invalidateLayout } = usePlayerOverlayObstacle('player-controls', 'playback', !isHidden);
    // 命令面板从胶囊原地长出来时要量它，所以胶囊节点除了交给遮挡登记，也留一份自己的。
    const capsuleElementRef = useRef<HTMLDivElement | null>(null);
    // 果冻注入开关：页面切换时先摘掉，等胶囊的 layout 动画放完再挂回去。
    const [jellyArmed, setJellyArmed] = useState(true);
    const jellyRearmRafRef = useRef<number | null>(null);
    const capsuleElRef = useRef<HTMLElement | null>(null);
    const disarmJelly = useCallback(() => {
        // 先让进行中的会话收摊：它写的是同一个 inline transform，留着会和 layout 动画互相覆盖。
        releaseGlassJelly();
        setJellyArmed(false);
        if (jellyRearmRafRef.current !== null) {
            cancelAnimationFrame(jellyRearmRafRef.current);
            jellyRearmRafRef.current = null;
        }
        // 等 transform 连续若干帧不再变化（layout spring 放完）再挂回果冻。
        // 读的是 inline transform（framer 的 layout 动画逐帧写这里），不触发样式重算；
        // 只靠 DOM 状态判断，不依赖动画库的回调。超时是动画被打断时的保险。
        const startedAt = performance.now();
        let lastTransform: string | null = null;
        let quietFrames = 0;
        const waitForSettle = () => {
            jellyRearmRafRef.current = null;
            const el = capsuleElRef.current;
            if (!el || !el.isConnected) {
                setJellyArmed(true);
                return;
            }
            const transform = el.style.transform;
            quietFrames = transform === lastTransform ? quietFrames + 1 : 0;
            lastTransform = transform;
            const elapsed = performance.now() - startedAt;
            // 至少等一小段：切换那一帧 transform 还没开始变，只比一次会立刻判成「已静止」。
            const settled = elapsed >= JELLY_REARM_MIN_WAIT_MS
                && (quietFrames >= JELLY_REARM_QUIET_FRAMES || elapsed >= JELLY_REARM_MAX_WAIT_MS);
            if (settled) {
                setJellyArmed(true);
                return;
            }
            jellyRearmRafRef.current = requestAnimationFrame(waitForSettle);
        };
        jellyRearmRafRef.current = requestAnimationFrame(waitForSettle);
    }, []);
    // 胶囊节点同时交给 overlay 布局登记、命令面板 morph 计时和果冻重挂的等待逻辑。
    const capsuleRef = useCallback((element: HTMLDivElement | null) => {
        layoutRef(element);
        capsuleElementRef.current = element;
        capsuleElRef.current = element;
    }, [layoutRef]);
    // 面板正以胶囊为外壳开着：胶囊自己淡出，免得两个叠在一起。
    const isMorphedIntoPalette = useCapsulePaletteStore(state => state.isMorphed);
    // 刚从命令面板交还回来的那一次渲染：淡入要快，才能接上面板最后那点淡出。
    // 动画只在开始时读一次 transition，所以只要翻转的那一次渲染判断对就够了。
    const wasMorphedRef = useRef(false);
    const morphJustEnded = wasMorphedRef.current && !isMorphedIntoPalette;
    useEffect(() => {
        wasMorphedRef.current = isMorphedIntoPalette;
    }, [isMorphedIntoPalette]);
    // const isDaylight = theme?.name === 'Daylight Default'; // Deprecated, passed as prop
    // 胶囊自己的描边和投影；换按钮的浮层、上方的浮动命令照这个底色做成 capsuleGlass，边沿另用面板那条线。
    const glassBgExpanded = isDaylight ? 'bg-white/60 border border-white/20 shadow-xl' : 'bg-black/40 border border-white/5';
    const glassBgCollapsed = isDaylight ? 'bg-white/40 border border-white/20 shadow-lg hover:bg-white/50' : 'bg-black/20 border border-white/5 hover:bg-black/30';
    const trackColor = isDaylight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.1)';
    // Button bg logic
    const buttonBg = isDaylight ? { backgroundColor: primaryColor, color: 'var(--bg-color)' } : { backgroundColor: primaryColor, color: 'var(--bg-color)' }; // Keep primary for play button, looks good

    // Other buttons hover
    const iconBtnExpandedClass = isDaylight ? 'hover:bg-black/5' : 'bg-white/20'; // Wait, loop button has logic
    const iconBtnClass = isDaylight ? 'hover:bg-black/5 text-black/60' : 'hover:bg-white/10 opacity-40 hover:opacity-100';

    const [isHovered, setIsHovered] = useState(false);
    // 最近一次进入悬停区的是不是手指。只在进入和按下时写、值不变就不更新，不跟指针移动。
    const [isTouchHover, setIsTouchHover] = useState(false);
    // 手指没有悬停：播放页上点开胶囊、或者一暂停，上方那排命令就直接浮出，连同撑开的胶囊
    // TOUCH_REVEAL_MS 没碰就一起收起；点胶囊以外的地方立刻收。
    const [isTouchRevealed, setIsTouchRevealed] = useState(false);
    const touchRevealTimerRef = useRef<number | null>(null);
    // 悬停区：胶囊和浮在它上方的那两样。在这里面按下算「还在用」，在外面按下就收。
    const hoverAreaRef = useRef<HTMLDivElement | null>(null);
    const stopTouchRevealTimer = useCallback(() => {
        if (touchRevealTimerRef.current !== null) {
            window.clearTimeout(touchRevealTimerRef.current);
            touchRevealTimerRef.current = null;
        }
    }, []);
    const startTouchRevealTimer = useCallback(() => {
        stopTouchRevealTimer();
        touchRevealTimerRef.current = window.setTimeout(() => {
            touchRevealTimerRef.current = null;
            setIsTouchRevealed(false);
        }, TOUCH_REVEAL_MS);
    }, [stopTouchRevealTimer]);
    const revealOnTouch = useCallback(() => {
        setIsTouchRevealed(true);
        startTouchRevealTimer();
    }, [startTouchRevealTimer]);
    const endTouchReveal = useCallback(() => {
        stopTouchRevealTimer();
        setIsTouchRevealed(false);
    }, [stopTouchRevealTimer]);
    // 触屏上点胶囊本身：那排命令已经浮着就开命令面板，没浮着这一下只把它（和胶囊）点出来。
    // 那排此刻出不来（提议条占着、整排失效）时照旧：展开着就开面板，收起着就只展开。
    const showExpandedRef = useRef(false);
    const touchRowShownRef = useRef(false);
    const touchRowAllowedRef = useRef(false);
    const pressOpensPaletteRef = useRef(true);
    const clickOpensPaletteRef = useRef(false);
    // 这一下手指按下时要不要把那排点出来，以及按在哪：抬起时没怎么挪才算点，拖进度条不算。
    const touchRevealPressRef = useRef<{ x: number; y: number; } | null>(null);
    const swallowClickUntilRef = useRef(0);
    // 这一下按在哪、是不是按在进度条上：按在进度条上或按下后拖开了的，是拖进度，不是点胶囊（#1056）。
    const pressRef = useRef<{ x: number; y: number; onSeek: boolean; } | null>(null);
    const noteHoverPointer = useCallback((event: React.PointerEvent) => {
        setIsTouchHover(event.pointerType === 'touch');
        if (event.type === 'pointerdown') {
            // 又按下了一次：上一下点出那排补发的 click 早该过去了，这一下的 click 是真的。
            swallowClickUntilRef.current = 0;
            pressRef.current = { x: event.clientX, y: event.clientY, onSeek: isOnSeekTrack(event.target) };
            pressOpensPaletteRef.current = event.pointerType !== 'touch'
                || touchRowShownRef.current
                || (showExpandedRef.current && !touchRowAllowedRef.current);
            touchRevealPressRef.current = event.pointerType === 'touch' && clickOpensPaletteRef.current && !pressOpensPaletteRef.current
                ? { x: event.clientX, y: event.clientY }
                : null;
        }
    }, []);
    const [isTimelineOpen, setIsTimelineOpen] = useState(false);
    const expandTimeoutRef = useRef<number | null>(null);
    const collapseTimeoutRef = useRef<number | null>(null);

    const bottomBarBottomPx = usePlayerBottomBarBottomPx();
    const isPositioning = usePlayerBottomBarLayoutStore(state => state.isPositioning);
    const commitPositioning = usePlayerBottomBarLayoutStore(state => state.commitPositioning);
    const cancelPositioning = usePlayerBottomBarLayoutStore(state => state.cancelPositioning);
    // 拖动起点：按下时的指针 Y 和当时的偏移量。位移是相对的，靠这两个值换算成绝对偏移量。
    const dragOriginRef = useRef<{ pointerY: number; offset: number; } | null>(null);
    const [maxOffsetPx, setMaxOffsetPx] = useState(() => (
        typeof window === 'undefined'
            ? PLAYER_BOTTOM_BAR_BASE_OFFSET_PX
            : resolvePlayerBottomBarMaxOffset(window.innerHeight)
    ));

    const canAutoExpand = canTogglePlay && duration > 0;
    const showSlotSuggestion = slotSuggestion !== null && !isHidden && !isPositioning && slotPicker === null;
    // 浮动命令和提议占同一块地方，提议优先；换按钮的浮层开着时也让开。
    // 停留浮出只给能悬停的指针：触屏点一下也会补发 mouseenter，不拦的话点胶囊去播放页后这排会一直挂着。
    // 主指针是触屏的设备不走停留；带触屏的笔记本主指针是鼠标，再按这一次进来的是不是手指拦。
    // 手指另走下面的 showTouchQuickActions：点开胶囊或暂停时直接浮出。
    const supportsFinePointer = useSupportsFinePointer();
    const hasDwelled = useCapsuleQuickActionsDwell(isHovered && !isTouchHover);
    // 手指浮出的只在播放页：首页点胶囊是去播放页，歌曲墙上是定位到当前歌曲，都不是要这排。
    const touchRowAllowed = currentView === 'player' && !showSlotSuggestion && slotPicker === null
        && !isHidden && !isPositioning && !controlsDisabled;
    const showTouchQuickActions = isTouchRevealed && touchRowAllowed;
    touchRowShownRef.current = showTouchQuickActions;
    touchRowAllowedRef.current = touchRowAllowed;
    const showQuickActions = showTouchQuickActions || (supportsFinePointer && hasDwelled && !showSlotSuggestion && slotPicker === null
        && !isHidden && !isPositioning && !controlsDisabled);
    // 播放页上点胶囊本来就在要去的地方，这一下改成把胶囊变成命令面板；播放入口设成歌曲墙时
    // 这一下仍然去墙，不抢原有的跳转。
    const playbackEntryView = usePlaybackEntryViewStore(state => state.playbackEntryView);
    const isFmMode = usePlaybackStore(state => state.isFmMode);
    const clickOpensPalette = currentView === 'player'
        && resolvePlayerCapsuleNavigationTarget('player', playbackEntryView, isFmMode) === 'player';

    // 页面切换时胶囊的 layout 动画期间收掉果冻会话，动画落定后挂回（见 JELLY_REARM_* 注释）。
    useEffect(() => {
        disarmJelly();
    }, [currentView, disarmJelly]);
    // 液态玻璃注入：让 shinoinject 的玻璃渲染管线接管带 data-glass 的节点。
    useGlass();

    // 手指点胶囊就点出那排的地方（clickOpensPalette），补发的 mouseenter 不再撑开胶囊，撑开交给浮出计时，
    // 不然 4 秒后那排收了胶囊还开着。播放入口设成歌曲墙时手指点不出那排，胶囊照旧靠补发的 mouseenter 撑开，
    // 不然正在放时收起的胶囊里只有进度条，拿不到暂停和切歌。
    const hoverExpands = isHovered && !(isTouchHover && clickOpensPalette);
    // 定位模式强制展开：用户要看到的是最终形态的胶囊，而不是一条细进度条。
    // 更换浮层和提议开着时也展开：两者说的都是槽位按钮，按钮得看得见；提议条贴在胶囊上沿，
    // 要是悬停才展开，指针移上提议条那一下胶囊长高、提议条被顶走，会在展开和收起之间来回抖。
    // 刚换完按钮也再展开一会儿，让人看见换上去的结果。
    // 变成命令面板期间胶囊照常收起或展开，只是看不见：它在面板接手的那一刻就立刻隐去，
    // 收起时透过遮罩看不到它往下缩；面板收回时量的正是它此刻的样子，收回去的宽度就对得上。
    const showExpanded = isPositioning || hoverExpands || (isTouchRevealed && currentView === 'player') || slotPicker !== null || showSlotSuggestion || slotCustomization.isShowingChange || (canAutoExpand && playerState !== PlayerState.PLAYING && currentView !== 'home');
    showExpandedRef.current = showExpanded;

    // 一暂停就浮出：只在播放页、主指针是触屏（或者上一次碰胶囊的是手指）时。只认从播放到暂停那一下，
    // 打开应用、切到播放页时本来就停着的不算。
    const previousPlayerStateRef = useRef(playerState);
    useEffect(() => {
        const wasPlaying = previousPlayerStateRef.current === PlayerState.PLAYING;
        previousPlayerStateRef.current = playerState;
        // 控件隐着、胶囊正当着命令面板时不浮：那时收起的 effect 不会再跑，浮出去就没人收。
        const mustStayDown = isHidden || isPositioning || isMorphedIntoPalette;
        if (wasPlaying && playerState === PlayerState.PAUSED && currentView === 'player' && !mustStayDown
            && (!supportsFinePointer || isTouchHover)) {
            revealOnTouch();
        }
    }, [currentView, isHidden, isMorphedIntoPalette, isPositioning, isTouchHover, playerState, revealOnTouch, supportsFinePointer]);

    // 离开播放页、控件自动隐藏、进定位模式、胶囊变成命令面板：浮出的那排都不该留着，面板交还时胶囊照常收着。
    const touchRevealMustEnd = currentView !== 'player' || isHidden || isPositioning || isMorphedIntoPalette;
    useEffect(() => {
        if (touchRevealMustEnd) {
            endTouchReveal();
        }
    }, [endTouchReveal, touchRevealMustEnd]);

    // 浮着的时候：在悬停区里按下先停住计时（拖进度条、长按槽位时不能半路收起），抬起再重新数 4 秒；
    // 在外面按下（包括命令面板、换按钮的浮层）立刻收。只在浮着时挂监听，都是按下抬起级别的事件。
    useEffect(() => {
        if (!isTouchRevealed) {
            return;
        }
        const onPointerDown = (event: PointerEvent) => {
            if (event.target instanceof Node && hoverAreaRef.current?.contains(event.target)) {
                stopTouchRevealTimer();
                return;
            }
            endTouchReveal();
        };
        const onPointerUp = () => {
            if (touchRevealTimerRef.current === null) {
                startTouchRevealTimer();
            }
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('pointerup', onPointerUp, true);
        window.addEventListener('pointercancel', onPointerUp, true);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('pointerup', onPointerUp, true);
            window.removeEventListener('pointercancel', onPointerUp, true);
        };
    }, [endTouchReveal, isTouchRevealed, startTouchRevealTimer, stopTouchRevealTimer]);

    // 上限依赖视口高度，窗口变矮时要跟着收，否则虚线框会画到屏幕外。
    useEffect(() => {
        if (!isPositioning) {
            return;
        }

        const syncMax = () => setMaxOffsetPx(resolvePlayerBottomBarMaxOffset(window.innerHeight));
        syncMax();
        window.addEventListener('resize', syncMax);
        return () => window.removeEventListener('resize', syncMax);
    }, [isPositioning]);

    const handlePositionDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!isPositioning) {
            return;
        }
        dragOriginRef.current = { pointerY: e.clientY, offset: playerBottomBarLiveOffset.get() };
        e.currentTarget.setPointerCapture(e.pointerId);
    }, [isPositioning]);

    const handlePositionDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const origin = dragOriginRef.current;
        if (!origin) {
            return;
        }
        // 只写 MotionValue，不进 React 更新路径：这是 pointer move 级别的高频回调。
        // 指针往上走 clientY 变小，偏移量要变大，所以是 origin.pointerY - e.clientY。
        playerBottomBarLiveOffset.set(clampPlayerBottomBarOffset(
            origin.offset + (origin.pointerY - e.clientY),
            window.innerHeight,
        ));
    }, []);

    const handlePositionDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragOriginRef.current) {
            return;
        }
        dragOriginRef.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    }, []);

    // 定位模式只在播放页的控制条上成立。离开播放页或把控制条整条隐藏后，
    // 拖手和退出按钮都不在场了，状态留着会把胶囊永久钉在展开且不可交互的样子上。
    useEffect(() => {
        if (isPositioning && (currentView !== 'player' || hideControlBar)) {
            cancelPositioning();
        }
    }, [cancelPositioning, currentView, hideControlBar, isPositioning]);

    // 卸载时兜底：当前歌曲被清空会让整条控制条不再渲染，上面那个 effect 也就没机会跑，
    // 定位状态会残留成一个谁也退不出的模式。用 getState 读，避免把 cleanup 绑到回调身份上。
    const isPositioningRef = useRef(isPositioning);
    isPositioningRef.current = isPositioning;
    useEffect(() => () => {
        if (isPositioningRef.current) {
            usePlayerBottomBarLayoutStore.getState().cancelPositioning();
        }
    }, []);

    // 胶囊看得见、能点时才让命令面板从它长出来；隐藏、定位模式或整条不画时面板回到顶上的遮罩。
    const canAnchorPalette = !isHidden && !isPositioning && !hideControlBar;
    useEffect(() => {
        const element = capsuleElementRef.current;
        if (!canAnchorPalette || !element) {
            return;
        }
        const store = useCapsulePaletteStore.getState();
        store.setAnchor(element);
        return () => {
            if (useCapsulePaletteStore.getState().anchor === element) {
                useCapsulePaletteStore.getState().setAnchor(null);
            }
        };
    }, [canAnchorPalette]);

    // 进入定位模式或整排失效时，浮层指着的那个按钮已经不能用了。
    useEffect(() => {
        if (slotPicker && (isPositioning || controlsDisabled)) {
            closeSlotPicker();
        }
    }, [closeSlotPicker, controlsDisabled, isPositioning, slotPicker]);

    const handleCommitPositioning = useCallback(() => {
        onCommitBottomBarOffset(commitPositioning());
    }, [commitPositioning, onCommitBottomBarOffset]);

    // Esc 取消回滚，Enter 确认。定位模式是个全屏态，键盘出口是必须的。
    useEffect(() => {
        if (!isPositioning) {
            return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                cancelPositioning();
            } else if (event.key === 'Enter') {
                event.preventDefault();
                handleCommitPositioning();
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [cancelPositioning, handleCommitPositioning, isPositioning]);

    // 命中区补丁按离底距离收敛。抬高后胶囊下面不再是屏幕边缘，多出来的 padding
    // 只会变成一块吃掉指针事件的死区。
    //
    // 读的是已保存值而不是拖动中的 MotionValue：这个数要参与 padding/margin 的布局计算，
    // 跟着每帧变就得每帧 setState。拖动过程中 hover 展开本来也不起作用，落定后自然就对了。
    const savedBottomBarOffset = usePlayerChromeSettingsStore(state => state.playerBottomBarOffset);
    const hoverHitboxBufferPx = Math.max(
        0,
        Math.round(HOVER_HITBOX_BOTTOM_BUFFER_PX - (savedBottomBarOffset - PLAYER_BOTTOM_BAR_BASE_OFFSET_PX)),
    );

    // 槽位上下文：调用方给的那份，加上胶囊自己掌握的循环模式、歌词时间轴和相邻曲目可用性。
    const resolvedSlotContext = useMemo<PlayerControlSlotContext>(() => ({
        ...slotContext,
        loopMode,
        onToggleLoop,
        onToggleTimeline: () => setIsTimelineOpen(true),
        hasLyrics: !!lyrics,
        canPrev: !!trackNavigation?.canPrev,
        canNext: !!trackNavigation?.canNext,
        onPrev: trackNavigation?.onPrev ?? (() => { }),
        onNext: trackNavigation?.onNext ?? (() => { }),
    }), [lyrics, loopMode, onToggleLoop, slotContext, trackNavigation]);

    useEffect(() => {
        return () => {
            if (expandTimeoutRef.current !== null) {
                window.clearTimeout(expandTimeoutRef.current);
            }
            if (collapseTimeoutRef.current !== null) {
                window.clearTimeout(collapseTimeoutRef.current);
            }
            if (touchRevealTimerRef.current !== null) {
                window.clearTimeout(touchRevealTimerRef.current);
            }
        };
    }, []);

    const handleMouseEnter = () => {
        if (collapseTimeoutRef.current !== null) {
            window.clearTimeout(collapseTimeoutRef.current);
            collapseTimeoutRef.current = null;
        }

        if (expandTimeoutRef.current !== null) {
            return;
        }

        expandTimeoutRef.current = window.setTimeout(() => {
            setIsHovered(true);
            expandTimeoutRef.current = null;
        }, HOVER_EXPAND_DELAY_MS);
    };

    const handleMouseLeave = () => {
        if (expandTimeoutRef.current !== null) {
            window.clearTimeout(expandTimeoutRef.current);
            expandTimeoutRef.current = null;
        }

        if (!isHovered || collapseTimeoutRef.current !== null) {
            return;
        }

        collapseTimeoutRef.current = window.setTimeout(() => {
            setIsHovered(false);
            collapseTimeoutRef.current = null;
        }, HOVER_COLLAPSE_DELAY_MS);
    };

    clickOpensPaletteRef.current = clickOpensPalette && !isPositioning;

    // 手指抬起时点出来：收起的胶囊大半是进度条（range input），点它浏览器不发 click，只能看抬起。
    // 只认点在胶囊本身上、又不是里面的按钮：暂停着胶囊本来就开着，点播放键是要继续放，不是要这排。
    const handleTouchRevealRelease = (event: React.PointerEvent) => {
        const press = touchRevealPressRef.current;
        touchRevealPressRef.current = null;
        const target = event.target instanceof Element ? event.target : null;
        if (!press || !target || !capsuleElementRef.current?.contains(target) || target.closest('button')) {
            return;
        }
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < TOUCH_TAP_SLOP_PX) {
            revealOnTouch();
            // 胶囊这就撑开了；点在别处时浏览器随后补发的 click 按手指位置落到展开后的内容上，
            // 多半是播放键，点一下歌就停了。这一下 click 在捕获阶段吞掉。
            swallowClickUntilRef.current = performance.now() + TOUCH_STRAY_CLICK_MS;
        }
    };
    const swallowStrayClick = (event: React.MouseEvent) => {
        if (performance.now() < swallowClickUntilRef.current) {
            swallowClickUntilRef.current = 0;
            event.preventDefault();
            event.stopPropagation();
        }
    };

    // 拖进度条松开时浏览器补发的 click 落到胶囊上，就成了点胶囊开命令面板（#1056）。进度条只有
    // 6px 高，按偏几像素就按在了胶囊空白处，按下和松开都在胶囊里，click 照常补发；按准了的，
    // 进度条在拖动中展开时被换掉、按住的元素没了，click 也会落到两处的共同祖先上。所以到了胶囊
    // 这里的 click，按下后挪开过、或者按在进度条上的，都不算点胶囊。按钮、模组的按钮和图层、
    // 进度条自己的 click 各自拦着，到不了这里，不受影响；键盘和读屏发的 click 没有按下（detail 为 0），照常算。
    const isDragRelease = (event: React.MouseEvent): boolean => {
        const press = pressRef.current;
        pressRef.current = null;
        if (!press || event.detail === 0) return false;
        return press.onSeek || Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_DRAG_SLOP_PX;
    };

    const handleClick = (event: React.MouseEvent) => {
        if (isDragRelease(event) || isPositioning) {
            return;
        }
        if (clickOpensPalette) {
            // 手指这一下没开面板的，抬起时已经把那排点出来了（handleTouchRevealRelease）。
            if (pressOpensPaletteRef.current) {
                openCommandPalette();
            }
            return;
        }
        if (currentView !== 'lattice') {
            onNavigateToPlayer();
        } else {
            onFocusLatticeCurrentSong?.();
        }
    };

    if (hideControlBar) {
        return null;
    }

    return (
        <>
            {/*
                定位层和动画层必须分开。这一层用 Tailwind 的 `-translate-x-1/2` 做水平居中，
                而下面那层的 animate 会写 y/scale —— framer-motion 生成的 transform 会整个
                盖掉同一节点上的 Tailwind transform，合并两层会让胶囊丢失居中、向右偏出去。
                bottom 走共享 MotionValue（默认 32，即原来的 bottom-8），不是 transform 属性，
                所以挂在这一层不会干扰居中。
            */}
            <motion.div
                className={`absolute left-1/2 -translate-x-1/2 z-60 w-full flex justify-center pointer-events-none
                    ${currentView === 'home'
                        ? 'max-w-[calc(100vw-120px)] md:max-w-[min(calc(32rem_+_var(--folium-player-bar-extra,0px)),calc(100vw-120px))]'
                        : 'max-w-[min(calc(32rem_+_var(--folium-player-bar-extra,0px)),100vw)] px-4'}`}
                style={{ bottom: bottomBarBottomPx }}
                onUpdate={invalidateLayout}
            >
            {/* 这一层的透明度、位移和缩放全由下面的 animate 驱动，不再叠一层 CSS transition：
                那样 framer 每帧写的值又被 CSS 拖慢 300ms，变成命令面板那一刻胶囊没法立刻让出来。 */}
            <motion.div
                className="w-full flex justify-center pointer-events-none"
                onUpdate={invalidateLayout}
                initial={false}
                animate={{
                    opacity: isHidden || isMorphedIntoPalette ? 0 : 1,
                    y: isHidden ? 24 : 0,
                    scale: isHidden ? 0.97 : 1,
                }}
                // 面板接手的那一刻胶囊立刻让出来；交还时在面板最后的淡出里很快接上，两边只交叉一下。
                transition={{ duration: isMorphedIntoPalette ? 0 : morphJustEnded ? 0.1 : 0.26, ease: 'easeOut' }}
                style={{ pointerEvents: isHidden || isMorphedIntoPalette ? 'none' : 'auto' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div
                    ref={hoverAreaRef}
                    className="pointer-events-auto relative w-full flex justify-center"
                    onMouseEnter={handleMouseEnter}
                    onMouseLeave={handleMouseLeave}
                    onPointerEnter={noteHoverPointer}
                    onPointerDown={noteHoverPointer}
                    onPointerUp={handleTouchRevealRelease}
                    onClickCapture={swallowStrayClick}
                    style={{
                        // 这块向下的命中区补丁只在胶囊贴底时才有意义；抬高之后按当前偏移量收敛，
                        // 否则胶囊下方会留一条既不可点也挡不住东西的死区。
                        paddingBottom: `${hoverHitboxBufferPx}px`,
                        marginBottom: `${-hoverHitboxBufferPx}px`,
                    }}
                >
                    {/* 定位层和动画层分开，理由同上：提示条的 y 动画不能盖掉居中用的布局。 */}
                    <div className="pointer-events-none absolute bottom-full left-0 right-0 mb-3 flex justify-center">
                        <AnimatePresence>
                            {showSlotSuggestion && slotSuggestion && (
                                <PlayerControlSlotSuggestion
                                    key={slotSuggestion}
                                    actionId={slotSuggestion}
                                    slotPrimary={slotPrimary}
                                    slotSecondary={slotSecondary}
                                    onReplace={slotCustomization.acceptSuggestion}
                                    onDismiss={slotCustomization.dismissSuggestion}
                                    isDaylight={isDaylight}
                                />
                            )}
                        </AnimatePresence>
                    </div>
                    <div className="pointer-events-none absolute bottom-full left-0 right-0 flex justify-center">
                        <AnimatePresence>
                            {showQuickActions && (
                                <CapsuleQuickActions
                                    key="quick-actions"
                                    slotPrimary={slotPrimary}
                                    slotSecondary={slotSecondary}
                                    context={resolvedSlotContext}
                                    isDaylight={isDaylight}
                                    touch={showTouchQuickActions}
                                />
                            )}
                        </AnimatePresence>
                    </div>
                    <motion.div
                        ref={capsuleRef}
                        title={clickOpensPalette && !isPositioning ? t('player.capsuleOpensPalette') : undefined}
                        onUpdate={invalidateLayout}
                        onLayoutAnimationComplete={invalidateLayout}
                        layout
                        data-glass
                        // 果冻注入开关：页面切换的 layout 动画期间摘掉，动画放完由 disarmJelly 的帧循环挂回。
                        data-glass-jelly={jellyArmed ? '' : undefined}
                        data-glass-light
                        transition={{ layout: CONTROL_LAYOUT_SPRING }}
                        onClick={handleClick}
                        // 用原生 pointer 事件而不是 framer-motion 的 drag：位移已经由 playerBottomBarLiveOffset
                        // 经外层 lift 表达，再让 drag 往这个节点写一份 y 会叠加成两倍位移；
                        // 而且 dragConstraints 依赖的起始值放在 ref 里不会触发重渲染，读到的会是上一帧的。
                        data-ponder="player-bar"
                        onPointerDown={handlePositionDragStart}
                        onPointerMove={handlePositionDragMove}
                        onPointerUp={handlePositionDragEnd}
                        onPointerCancel={handlePositionDragEnd}
                        style={{
                            touchAction: isPositioning ? 'none' : undefined,
                            backgroundColor: isDaylight
                                ? 'rgba(255,255,255,0.4)'
                                : 'rgba(0,0,0,0.4)',
                            borderTop: isDaylight
                                ? '1px solid rgba(0,0,0,0.08)'
                                : '1px solid rgba(255,255,255,0.12)',
                            borderBottom: isDaylight
                                ? '1px solid rgba(0,0,0,0.08)'
                                : '1px solid rgba(255,255,255,0.12)',
                            outline: '1px solid rgba(40,40,40,0.2)',
                            boxShadow: '2px 2px 8px 2px rgba(40,40,40,0.4)',
                        }}
                        className={`backdrop-blur-xl shadow-2xl overflow-hidden rounded-full relative isolate transition-colors duration-300 select-none
                            ${isPositioning ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}
                            ${showExpanded ? `p-3 ${glassBgExpanded} w-full` : `px-4 py-2 ${glassBgCollapsed} ${COLLAPSED_WIDTH_CLASS}`}`}
                    >
                        {/* 播放时从胶囊底边发出的水光：在胶囊内部，z-index: -1 压在内容下面、
                            浮在胶囊自己的底色上面，照亮底边而不盖住控件。
                            expanded 传进去：胶囊展开/收起时画布要重新量一次尺寸。 */}
                        <PlayerBarGlow active={playerState === PlayerState.PLAYING} expanded={showExpanded} />
                        <motion.div
                            layout
                            transition={{ layout: CONTROL_LAYOUT_SPRING }}
                            // 定位模式下 seek 和所有按钮一起失效：这时胶囊是个被拖的物体，不是控件。
                            className={`w-full ${isPositioning ? 'pointer-events-none select-none' : ''}`}
                        >
                            {showExpanded ? (
                                <ExpandedView
                                    currentSong={currentSong}
                                    playerState={playerState}
                                    currentTime={currentTime}
                                    lyricCurrentTime={lyricCurrentTime}
                                    duration={duration}
                                    canTogglePlay={canTogglePlay}
                                    onSeek={onSeek}
                                    onTogglePlay={onTogglePlay}
                                    noTrackText={noTrackText}
                                    primaryColor={primaryColor}
                                    secondaryColor={secondaryColor}
                                    trackColor={trackColor}
                                    isDaylight={isDaylight}
                                    controlsDisabled={controlsDisabled || isPositioning}
                                    trackNavigation={trackNavigation}
                                    slotPrimary={slotPrimary}
                                    slotSecondary={slotSecondary}
                                    slotContext={resolvedSlotContext}
                                    onCustomizePrimary={slotCustomization.openPrimaryPicker}
                                    onCustomizeSecondary={slotCustomization.openSecondaryPicker}
                                />
                            ) : (
                                <CollapsedView
                                    currentTime={currentTime}
                                    duration={duration}
                                    onSeek={onSeek}
                                    primaryColor={primaryColor}
                                    secondaryColor={secondaryColor}
                                    trackColor={trackColor}
                                    controlsDisabled={controlsDisabled}
                                />
                            )}
                        </motion.div>
                    </motion.div>
                </div>
            </motion.div>
            </motion.div>

            {slotPicker && (
                <PlayerControlSlotPicker
                    anchorRect={slotPicker.anchorRect}
                    side={slotPicker.side}
                    current={slotPicker.side === 'primary' ? slotPrimary : slotSecondary}
                    other={slotPicker.side === 'primary' ? slotSecondary : slotPrimary}
                    onSelect={(actionId) => {
                        slotCustomization.assignSlot(slotPicker.side, actionId);
                        closeSlotPicker();
                    }}
                    onOpenSettings={() => {
                        closeSlotPicker();
                        openSettings('options', 'player', null, 'bottomUiSettings', 'playerControlSlots');
                    }}
                    onClose={closeSlotPicker}
                    isDaylight={isDaylight}
                />
            )}

            <AnimatePresence>
                {isPositioning && (
                    <PlayerBottomBarPositioner
                        maxOffsetPx={maxOffsetPx}
                        accentColor={primaryColor}
                        isDaylight={isDaylight}
                        onReset={() => playerBottomBarLiveOffset.set(PLAYER_BOTTOM_BAR_BASE_OFFSET_PX)}
                        onCommit={handleCommitPositioning}
                        onCancel={cancelPositioning}
                    />
                )}
            </AnimatePresence>

            <LyricsTimelineModal
                isOpen={isTimelineOpen}
                onClose={() => setIsTimelineOpen(false)}
                lyrics={lyrics}
                duration={duration}
                currentTime={lyricCurrentTime ?? currentTime}
                onSeek={(time) => {
                    const target = resolveLyricSeekMediaTime(time, {
                        mediaTimeSec: currentTime.get(),
                        lyricTimeSec: lyricCurrentTime?.get() ?? currentTime.get(),
                        durationSec: duration,
                    });
                    if (target !== null) onSeek(target);
                }}
                primaryColor={primaryColor}
                secondaryColor={secondaryColor}
                accentColor="var(--text-accent)"
                theme={theme}
                isDaylight={isDaylight}
                disabled={controlsDisabled}
            />
        </>
    );
};

/** 展开视图里进度那一行在网格中的位置；HiFi 路线和 Web 路线共用。 */
const PROGRESS_ROW_CLASS = 'col-span-3 row-start-3 w-full px-2 sm:col-start-2 sm:col-span-1 sm:row-start-2';

// 展开视图组件
interface ExpandedViewProps {
    currentSong: { name: string; } | null;
    playerState: PlayerState;
    currentTime: MotionValue<number>;
    lyricCurrentTime?: MotionValue<number>;
    duration: number;
    canTogglePlay: boolean;
    onSeek: (time: number) => void;
    onTogglePlay: () => void;
    noTrackText: string;
    primaryColor: string;
    secondaryColor: string;
    trackColor?: string;
    isDaylight?: boolean;
    controlsDisabled?: boolean;
    trackNavigation?: TrackNavigation | null;
    slotPrimary: PlayerControlSlotActionId;
    slotSecondary: PlayerControlSlotActionId;
    slotContext: PlayerControlSlotContext;
    onCustomizePrimary: (anchorRect: DOMRect) => void;
    onCustomizeSecondary: (anchorRect: DOMRect) => void;
}

const ExpandedView: React.FC<ExpandedViewProps> = ({
    currentSong,
    playerState,
    currentTime,
    lyricCurrentTime,
    duration,
    canTogglePlay,
    onSeek,
    onTogglePlay,
    noTrackText,
    primaryColor,
    secondaryColor,
    trackColor,
    isDaylight,
    controlsDisabled = false,
    trackNavigation = null,
    slotPrimary,
    slotSecondary,
    slotContext,
    onCustomizePrimary,
    onCustomizeSecondary,
}) => {
    const isHifiRoute = useIsHifiRoute();
    const progressBar = (
        <ProgressBar
            currentTime={currentTime}
            duration={duration}
            onSeek={onSeek}
            primaryColor={primaryColor}
            secondaryColor={secondaryColor}
            trackColor={trackColor}
            disabled={controlsDisabled}
        />
    );

    return (
        <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-x-4 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
            {/* Desktop Layout - responsive grid positions apply from the sm breakpoint */}
            {/* Mobile Layout - base grid positions apply below the sm breakpoint */}
            {/* Row 1: Centered Title */}
            <div className="col-span-3 row-start-1 min-w-0 px-2 sm:col-start-2 sm:col-span-1">
                {trackNavigation ? (
                    <TrackTitleNavigator
                        title={currentSong?.name || noTrackText}
                        trackKey={trackNavigation.currentTrackKey}
                        prevTitle={trackNavigation.prevTitle}
                        nextTitle={trackNavigation.nextTitle}
                        canPrev={trackNavigation.canPrev}
                        canNext={trackNavigation.canNext}
                        onPrev={trackNavigation.onPrev}
                        onNext={trackNavigation.onNext}
                        prevLabel={trackNavigation.prevLabel}
                        nextLabel={trackNavigation.nextLabel}
                        color={primaryColor}
                        isDaylight={isDaylight}
                        disabled={controlsDisabled}
                    />
                ) : (
                    <div className="truncate text-center text-sm font-bold select-none" style={{ color: primaryColor }}>
                        {currentSong?.name || noTrackText}
                    </div>
                )}
            </div>

            {/* Row 3: Loop Button, Play Button, Lyrics Button */}
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    onTogglePlay();
                }}
                disabled={!canTogglePlay || controlsDisabled}
                className={`col-start-2 row-start-2 flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-none bg-(--text-primary) text-black shadow-lg transition-transform sm:col-start-1 sm:row-start-1 sm:row-span-2 ${controlsDisabled ? 'cursor-not-allowed opacity-45' : 'hover:scale-105'}`}
                style={{ backgroundColor: primaryColor, color: 'var(--bg-color)' }}
            >
                {playerState === PlayerState.PLAYING ? (
                    <Pause size={20} fill="currentColor" />
                ) : (
                    <Play size={20} fill="currentColor" className="ml-1" />
                )}
            </button>

            {/* 两个可自定义槽位。默认仍是循环模式 + 歌词时间轴，和改动前一致。 */}
            <div
                data-ponder-slots
                className="contents sm:col-start-3 sm:row-start-1 sm:row-span-2 sm:flex sm:items-center sm:gap-1"
            >
                <PlayerControlSlotButton
                    actionId={slotPrimary}
                    context={slotContext}
                    primaryColor={primaryColor}
                    isDaylight={isDaylight}
                    controlsDisabled={controlsDisabled}
                    className="col-start-1 row-start-2 justify-self-end sm:justify-self-auto"
                    onCustomize={onCustomizePrimary}
                />

                <PlayerControlSlotButton
                    actionId={slotSecondary}
                    context={slotContext}
                    primaryColor={primaryColor}
                    isDaylight={isDaylight}
                    controlsDisabled={controlsDisabled}
                    className="col-start-3 row-start-2 justify-self-start sm:justify-self-auto"
                    onCustomize={onCustomizeSecondary}
                />
            </div>

            {/* Row 2: Current Time, Progress Bar, Duration */}
            {/* HiFi 路线上时长后面多一块 HiFi 徽标，按这一行的宽度换长短，进度条留够最小宽度；Web 路线和原来一模一样。 */}
            {isHifiRoute ? (
                <HifiProgressRow className={PROGRESS_ROW_CLASS} isDaylight={isDaylight} disabled={controlsDisabled}>
                    {progressBar}
                </HifiProgressRow>
            ) : (
                <div className={PROGRESS_ROW_CLASS}>{progressBar}</div>
            )}
        </div>
    );
};

// 折叠视图组件
interface CollapsedViewProps {
    currentTime: MotionValue<number>;
    duration: number;
    onSeek: (time: number) => void;
    primaryColor: string;
    secondaryColor: string;
    trackColor?: string;
    controlsDisabled?: boolean;
}

const CollapsedView: React.FC<CollapsedViewProps> = ({
    currentTime,
    duration,
    onSeek,
    primaryColor,
    secondaryColor,
    trackColor,
    controlsDisabled = false,
}) => {
    return (
        <div className="flex items-center w-full justify-center h-8 px-4">
            <ProgressBar
                currentTime={currentTime}
                duration={duration}
                onSeek={onSeek}
                primaryColor={primaryColor}
                secondaryColor={secondaryColor}
                trackColor={trackColor}
                disabled={controlsDisabled}
                collapsed
            />
        </div>
    );
};

export default FloatingPlayerControls;
