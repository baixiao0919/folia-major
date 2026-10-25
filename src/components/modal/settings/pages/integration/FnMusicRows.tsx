import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Reveal, Row, Status, TextField, Toggle } from '../../kit';
import { useSettingsPage } from '../settingsPageContext';
import { O } from './options';

// src/components/modal/settings/pages/integration/FnMusicRows.tsx
// The 飞牛音乐 rows of the 连接与集成 page, mirroring Navidrome: the switch, the server address,
// the account and password, and a row that tests the connection and saves it on success. The
// connection test runs the real login against the fnOS Music API (electron/fnmusic bridge in the
// desktop app), and the saved config is what the login window and the provider consume.

export const FnMusicRows: React.FC = () => {
    const { t } = useTranslation();
    const {
        fnmusicConfigured: configured,
        fnmusicEnabled: enabled,
        fnmusicPassword: password,
        fnmusicTestError: testError,
        fnmusicTestStatus: testStatus,
        fnmusicUrl: url,
        fnmusicUsername: username,
        onClearFnMusic,
        onToggleFnMusic,
        setFnMusicPassword,
        setFnMusicUrl,
        setFnMusicUsername,
        testFnMusicConnection,
    } = useSettingsPage().viewProps.integration.fnmusic;
    const testing = testStatus === 'testing';

    return (
        <>
            <Row option={O.fnmusic}>
                <Toggle checked={enabled} onChange={onToggleFnMusic} />
            </Row>
            <Reveal when={enabled}>
                <Row sub option={O.fnmusicUrl}>
                    <TextField type="url" value={url} onChange={setFnMusicUrl} placeholder={t('fnmusic.serverUrlPlaceholder')} />
                </Row>
                <Row sub option={O.fnmusicUsername}>
                    <TextField value={username} onChange={setFnMusicUsername} placeholder={t('fnmusic.usernamePlaceholder')} />
                </Row>
                <Row sub option={O.fnmusicPassword}>
                    <TextField type="password" value={password} onChange={setFnMusicPassword} placeholder={configured ? '••••••••' : undefined} />
                </Row>
                <Row
                    sub
                    label={testStatus === 'failed'
                        ? <Status tone="error">{testError || t('fnmusic.connectionFailed')}</Status>
                        : configured
                            ? <Status tone="ok">{t('fnmusic.connectionSuccess')}</Status>
                            : <Status>{t('fnmusic.notConfigured')}</Status>}
                    hint={configured && username ? t('fnmusic.signedInAs', { account: username }) : undefined}
                >
                    {configured && <Button onClick={onClearFnMusic}>{t('fnmusic.clearSettings')}</Button>}
                    <Button
                        variant="primary"
                        onClick={() => void testFnMusicConnection()}
                        disabled={testing || !url || !username || !password}
                    >
                        {testing ? t('fnmusic.testing') : t('fnmusic.testConnection')}
                    </Button>
                </Row>
            </Reveal>
        </>
    );
};

export default FnMusicRows;
