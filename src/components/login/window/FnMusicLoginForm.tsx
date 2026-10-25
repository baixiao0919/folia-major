import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    fnMusicLogin,
    loadFnMusicConfig,
    type FnMusicServerConfig,
} from '../../../services/onlineMusic/fnmusic/fnmusicTransport';

// src/components/login/window/FnMusicLoginForm.tsx
// 飞牛音乐账号密码登录表单：登录窗口右侧直接输入服务器地址 / fnOS 账号 / 密码，点「登录」保存配置并完成登录，
// 登录成功后交给 Folia 的登录状态机（onStart → retryLogin → confirmed）收尾，不需要先到设置页配置。
export const FnMusicLoginForm: React.FC<{ onStart: () => void }> = ({ onStart }) => {
    const { t } = useTranslation();
    const remembered = loadFnMusicConfig();
    const [url, setUrl] = useState(() => {
        if (remembered) return `${remembered.https ? 'https' : 'http'}://${remembered.host}:${remembered.port}`;
        return 'http://192.168.1.10:5666';
    });
    const [account, setAccount] = useState(() => remembered?.account ?? '');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canSubmit = Boolean(url.trim() && account.trim() && password) && !busy;

    const submit = async () => {
        if (!canSubmit) return;
        setBusy(true);
        setError(null);
        let parsed: URL;
        try {
            parsed = new URL(url.includes('://') ? url : `http://${url}`);
        } catch {
            setError(t('fnmusic.badUrl'));
            setBusy(false);
            return;
        }
        const config: FnMusicServerConfig = {
            host: parsed.hostname,
            port: parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 5667 : 5666),
            https: parsed.protocol === 'https:',
            account: account.trim(),
            password,
            loginType: 0,
        };
        try {
            await fnMusicLogin(config);
            onStart();
        } catch (caught) {
            console.warn('[FnMusicLoginForm] login failed:', caught);
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    const inputStyle: React.CSSProperties = {
        display: 'block',
        width: '100%',
        boxSizing: 'border-box',
        marginTop: 10,
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid rgba(148,163,184,0.35)',
        background: 'rgba(15,23,42,0.6)',
        color: 'inherit',
        fontSize: 14,
        outline: 'none',
    };
    const labelStyle: React.CSSProperties = { display: 'block', marginTop: 14, fontSize: 13, opacity: 0.75 };

    return (
        <div style={{ width: '100%', maxWidth: 360, padding: '6px 0 10px' }}>
            <div style={{ fontSize: 17, fontWeight: 600 }}>{t('fnmusic.loginTitle')}</div>
            <div style={{ fontSize: 13, opacity: 0.7, marginTop: 6, lineHeight: 1.5 }}>
                {t('fnmusic.loginNote')}
            </div>
            <label style={labelStyle}>{t('fnmusic.serverUrl')}</label>
            <input
                type="url"
                value={url}
                onChange={event => setUrl(event.target.value)}
                placeholder={t('fnmusic.serverUrlPlaceholder')}
                style={inputStyle}
            />
            <label style={labelStyle}>{t('fnmusic.username')}</label>
            <input
                value={account}
                onChange={event => setAccount(event.target.value)}
                placeholder={t('fnmusic.usernamePlaceholder')}
                style={inputStyle}
            />
            <label style={labelStyle}>{t('fnmusic.password')}</label>
            <input
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                placeholder={remembered ? '••••••••' : undefined}
                onKeyDown={event => { if (event.key === 'Enter') void submit(); }}
                style={inputStyle}
            />
            {error && <div style={{ marginTop: 10, fontSize: 13, color: '#f87171' }}>{error}</div>}
            <button
                type="button"
                disabled={!canSubmit}
                onClick={() => void submit()}
                style={{
                    marginTop: 16,
                    width: '100%',
                    padding: '11px 0',
                    borderRadius: 8,
                    border: 'none',
                    background: canSubmit ? '#16a34a' : 'rgba(148,163,184,0.25)',
                    color: '#fff',
                    fontSize: 15,
                    fontWeight: 600,
                    cursor: canSubmit ? 'pointer' : 'default',
                }}
            >
                {busy ? t('fnmusic.testing') : t('fnmusic.login')}
            </button>
        </div>
    );
};

export default FnMusicLoginForm;
