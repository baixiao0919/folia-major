import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OnlineProviderId } from '../../../types/onlineMusic';
import { omni } from '../../../services/onlineMusic/omni';

// src/components/login/window/FormLogin.tsx
// 通用表单式登录：按 provider 声明的 ProviderLoginForm（omni.getLoginForm）渲染字段并提交。
// 提交成功交给登录状态机（onStart → retryLogin → confirmed）。接入账号密码平台不需要再改登录界面。
export const FormLogin: React.FC<{ providerId: OnlineProviderId; onStart: () => void }> = ({ providerId, onStart }) => {
    const { t } = useTranslation();
    const form = omni.getLoginForm(providerId);
    const texts = omni.getLoginTexts(providerId);
    const [values, setValues] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!form) return null;

    const canSubmit = !busy && form.fields.every(field => !field.required || Boolean((values[field.key] ?? '').trim()));

    const submit = async () => {
        if (!canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            await omni.submitLoginForm(providerId, values);
            onStart();
        } catch (caught) {
            console.warn('[FormLogin] login failed:', caught);
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    const inputClass = 'mt-2.5 block w-full box-border rounded-lg border border-slate-400/35 bg-slate-900/60 px-3 py-2.5 text-sm outline-none';
    const labelClass = 'mt-3.5 block text-[13px] opacity-75';

    return (
        <div className="w-full max-w-[360px] px-0.5 py-1.5 pb-2.5">
            {texts?.title && <div className="text-[17px] font-semibold">{t(texts.title)}</div>}
            {form.noteKey && <div className="mt-1.5 text-[13px] leading-relaxed opacity-70">{t(form.noteKey)}</div>}
            {!form.noteKey && texts?.note && <div className="mt-1.5 text-[13px] leading-relaxed opacity-70">{t(texts.note)}</div>}
            {form.fields.map(field => (
                <label key={field.key} className={labelClass}>
                    {field.labelKey ? t(field.labelKey) : (field.label ?? field.key)}
                    <input
                        type={field.type}
                        value={values[field.key] ?? ''}
                        onChange={event => setValues(prev => ({ ...prev, [field.key]: event.target.value }))}
                        placeholder={field.placeholderKey ? t(field.placeholderKey) : field.placeholder}
                        onKeyDown={event => { if (event.key === 'Enter') void submit(); }}
                        className={inputClass}
                        autoComplete={field.type === 'password' ? 'current-password' : 'off'}
                    />
                </label>
            ))}
            {error && <div className="mt-2.5 text-[13px] text-red-400">{error}</div>}
            <button
                type="button"
                disabled={!canSubmit}
                onClick={() => void submit()}
                className={`mt-4 w-full rounded-lg py-2.5 text-[15px] font-semibold text-white ${canSubmit ? 'bg-green-600 hover:bg-green-500' : 'cursor-default bg-slate-400/25'}`}
            >
                {busy ? t('home.loginMethodPending') : (form.submitLabelKey ? t(form.submitLabelKey) : (form.submitLabel ?? '登录'))}
            </button>
        </div>
    );
};

export default FormLogin;
