import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Volume2, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import {
  getSpeakerVolume,
  lanCastErrorText,
  setSpeakerMuted,
  setSpeakerVolume,
  supportsSpeakerVolume,
  type LanSpeaker,
} from '../../services/lanCast';

// src/components/lan-cast/LanCastRemote.tsx
// 投送成功后的音响遥控面板：只看这台音响的音量与静音，外加换一台和断开。
//
// 与安卓那边一致：这里故意不放播放/暂停。播放控制归播放页，遥控面板再插一个播放键，
// 会和 Web 侧的 togglePlay 叠成两个真相来源，音响上就出现「面板说暂停、实际还在唱」。
// 组件只出 body，外壳（位置、浮层、玻璃底）由 LanCastControl 提供。

type LanCastRemoteProps = {
  speaker: LanSpeaker;
  isDaylight: boolean;
  /** 当前正在推给音响的曲目，遥控面板上标一行，确认「推到哪首了」。 */
  songTitle?: string;
  artist?: string;
  /** 回到设备列表，换一台音响。 */
  onBack: () => void;
  /** 停止投送并恢复本机声音。 */
  onStop: () => void;
};

const VOLUME_COMMIT_DELAY_MS = 220;

const LanCastRemote: React.FC<LanCastRemoteProps> = ({
  speaker,
  isDaylight,
  songTitle,
  artist,
  onBack,
  onStop,
}) => {
  const { t } = useTranslation();
  // 先按「设备报了 RenderingControl 地址」判断，真正的实现能力在读到音量后再确认。
  const [supported, setSupported] = useState(() => supportsSpeakerVolume(speaker));
  const [volume, setVolume] = useState(50);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');
  // 拖动时不能每 1px 发一条 SOAP：本地值跟手走，停手 220ms 才真正发给音响。
  const commitTimerRef = useRef<number | null>(null);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  const clearCommitTimer = () => {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
  };

  useEffect(() => clearCommitTimer, []);

  // 打开遥控面板时读一次音响的当前音量：以音响为准，而不是沿用上一台的数值。
  useEffect(() => {
    if (!supported) return;
    let alive = true;
    void getSpeakerVolume(speaker)
      .then(current => {
        if (!alive) return;
        setVolume(current.volume);
        setMuted(current.muted);
      })
      .catch((readError: unknown) => {
        if (!alive) return;
        // 读不到就当这台调不了音量：藏起滑块，别让用户对着一个永远没反应的条拖。
        setSupported(false);
        setError(lanCastErrorText(readError));
      });
    return () => { alive = false; };
  }, [speaker, supported]);

  const handleVolumeChange = useCallback((next: number) => {
    setVolume(next);
    setError('');
    clearCommitTimer();
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = null;
      void setSpeakerVolume(speaker, next).catch((writeError: unknown) => {
        setError(lanCastErrorText(writeError));
      });
    }, VOLUME_COMMIT_DELAY_MS);
  }, [speaker]);

  const handleToggleMute = useCallback(() => {
    const next = !muted;
    setError('');
    void setSpeakerMuted(speaker, next)
      .then(() => setMuted(next))
      .catch((muteError: unknown) => setError(lanCastErrorText(muteError)));
  }, [muted, speaker]);

  const mutedLook = isDaylight ? 'text-zinc-400' : 'text-white/45';

  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Button
            variant="bare"
            tip={t('lanCastSwitch') as string}
            aria-label={t('lanCastSwitch') as string}
            onClick={onBack}
            className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
              isDaylight ? 'text-zinc-500 hover:bg-black/5' : 'text-white/60 hover:bg-white/10'
            }`}
          >
            <ChevronLeft size={15} />
          </Button>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{speaker.name}</div>
            <div className={`mt-0.5 truncate text-[11px] ${isDaylight ? 'text-zinc-500' : 'text-white/55'}`}>
              {t('lanCastRemoteTitle')}
            </div>
          </div>
        </div>
      </div>

      {(songTitle || artist) && (
        <div className={`mt-3 truncate text-[11px] ${isDaylight ? 'text-zinc-600' : 'text-white/70'}`}>
          {[songTitle, artist].filter(Boolean).join(' · ')}
        </div>
      )}

      {supported ? (
        <div className="mt-3">
          <div className="flex items-center gap-2">
            <Button
              variant="bare"
              tip={t(muted ? 'lanCastUnmute' : 'lanCastMute') as string}
              aria-label={t(muted ? 'lanCastUnmute' : 'lanCastMute') as string}
              onClick={handleToggleMute}
              className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
                muted
                  ? mutedLook
                  : isDaylight ? 'text-zinc-600 hover:bg-black/5' : 'text-white/75 hover:bg-white/10'
              }`}
            >
              {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </Button>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={volume}
              disabled={muted}
              aria-label={t('lanCastVolume') as string}
              onChange={event => handleVolumeChange(Number(event.target.value))}
              className={`h-1 w-full cursor-pointer appearance-auto disabled:opacity-40 ${
                isDaylight ? 'accent-zinc-900' : 'accent-white'
              }`}
            />
            <span className={`w-8 shrink-0 text-right text-[11px] tabular-nums ${isDaylight ? 'text-zinc-500' : 'text-white/55'}`}>
              {muted ? t('lanCastMute') : `${volume}%`}
            </span>
          </div>
          {muted && (
            <div className={`mt-1.5 text-[11px] ${isDaylight ? 'text-zinc-500' : 'text-white/50'}`}>
              {t('lanCastMuteHint')}
            </div>
          )}
        </div>
      ) : (
        <div className={`mt-3 text-[11px] ${isDaylight ? 'text-zinc-500' : 'text-white/50'}`}>
          {t('lanCastVolumeUnsupported')}
        </div>
      )}

      {error && (
        <div className="mt-2 text-[11px] leading-relaxed text-red-500">{error}</div>
      )}

      <Button
        variant="fill"
        onClick={onStop}
        className="mt-3 w-full justify-center rounded-lg py-2 text-[12px]"
      >
        {t('lanCastStop')}
      </Button>
    </>
  );
};

export default LanCastRemote;
