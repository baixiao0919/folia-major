'use strict';

const http = require('http');
const https = require('https');

// AVTransport 的 SOAP 控制。安卓侧是 OkHttp，桌面端用 Node 的 http/https 发同一套报文。

const AV_TRANSPORT = 'urn:schemas-upnp-org:service:AVTransport:1';
// 音量/静音是另一个 service：SOAPACTION 里的 serviceType 必须跟着换，写死 AVTransport 会被设备拒。
const RENDERING_CONTROL = 'urn:schemas-upnp-org:service:RenderingControl:1';
const SOAP_TIMEOUT_MS = 8000;
const BODY_MAX_BYTES = 256 * 1024;

const escapeXml = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const envelope = body => '<?xml version="1.0" encoding="utf-8"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
    + 's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body>${body}</s:Body></s:Envelope>`;

/** 发一条 SOAP 动作。返回 { ok, status, fault }：ok 为 false 时 fault 里带设备给的原因。 */
const soapCall = (controlUrl, action, body, serviceType = AV_TRANSPORT) => new Promise((resolve, reject) => {
    let url;
    try {
        url = new URL(controlUrl);
    } catch {
        reject(new Error('音响控制地址不合法'));
        return;
    }
    const client = url.protocol === 'https:' ? https : http;
    const payload = Buffer.from(envelope(body), 'utf8');
    const request = client.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
            // SOAPACTION 必须带引号，规范要求。
            SOAPACTION: `"${serviceType}#${action}"`,
            'Content-Type': 'text/xml; charset="utf-8"',
            'Content-Length': payload.length,
            'User-Agent': 'Folia/1.0 UPnP/1.0',
            Connection: 'close',
        },
        timeout: SOAP_TIMEOUT_MS,
    }, response => {
        let received = 0;
        const chunks = [];
        response.on('data', chunk => {
            received += chunk.length;
            if (received > BODY_MAX_BYTES) {
                request.destroy(new Error('SOAP 响应过大'));
                return;
            }
            chunks.push(chunk);
        });
        response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            // UPnP 的错误用 500 + SOAP Fault 回，别把「设备收到了但拒绝」当成成功。
            const faulted = /<s:fault/i.test(text) || /UPnPError/i.test(text);
            const status = response.statusCode || 0;
            resolve({
                ok: status >= 200 && status < 300 && !faulted,
                status,
                fault: faulted ? firstFaultText(text) : '',
                body: text,
            });
        });
        response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('音响没有响应')));
    request.on('error', reject);
    request.write(payload);
    request.end();
});

const firstFaultText = text => {
    const description = /<errorDescription[^>]*>([\s\S]*?)<\/errorDescription>/i.exec(text);
    if (description) return description[1].trim();
    const code = /<errorCode[^>]*>([\s\S]*?)<\/errorCode>/i.exec(text);
    return code ? `错误码 ${code[1].trim()}` : '音响返回了错误';
};

const setUriBody = (audioUrl, metadata) => '<u:SetAVTransportURI xmlns:u="' + AV_TRANSPORT + '">'
    + '<InstanceID>0</InstanceID>'
    + `<CurrentURI>${escapeXml(audioUrl)}</CurrentURI>`
    + `<CurrentURIMetaData>${escapeXml(metadata)}</CurrentURIMetaData>`
    + '</u:SetAVTransportURI>';

const playBody = '<u:Play xmlns:u="' + AV_TRANSPORT + '">'
    + '<InstanceID>0</InstanceID><Speed>1</Speed></u:Play>';

const stopBody = '<u:Stop xmlns:u="' + AV_TRANSPORT + '">'
    + '<InstanceID>0</InstanceID></u:Stop>';

/** DIDL-Lite 是塞在 XML 文本节点里的，所以整体还要在 setUriBody 里再转义一次。 */
const didlMetadata = ({ url, title, artist, album, coverUrl, durationMs }) => {
    const seconds = Math.max(0, Math.floor((Number(durationMs) || 0) / 1000));
    const duration = [
        String(Math.floor(seconds / 3600)).padStart(2, '0'),
        String(Math.floor((seconds % 3600) / 60)).padStart(2, '0'),
        String(seconds % 60).padStart(2, '0'),
    ].join(':');
    const art = /^https:\/\//i.test(String(coverUrl || ''))
        ? `<upnp:albumArtURI>${escapeXml(coverUrl)}</upnp:albumArtURI>`
        : '';
    const albumPart = album ? `<upnp:album>${escapeXml(album)}</upnp:album>` : '';
    return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
        + 'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        + 'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
        + '<item id="folia-0" parentID="-1" restricted="1">'
        + `<dc:title>${escapeXml(title)}</dc:title>`
        + `<dc:creator>${escapeXml(artist)}</dc:creator>`
        + albumPart
        + '<upnp:class>object.item.audioItem.musicTrack</upnp:class>'
        + art
        + `<res duration="${duration}" protocolInfo="http-get:*:audio/mpeg:*">`
        + `${escapeXml(url)}</res>`
        + '</item></DIDL-Lite>';
};

/**
 * 把一首歌交给音响：SetAVTransportURI 之后紧接着 Play。
 * 有些老设备解析不了 DIDL-Lite，正文送不进去就退成 NOT_IMPLEMENTED 再试一次：
 * 地址照样能播，只是音响上不显示歌名。
 */
const playOnSpeaker = async (controlUrl, track) => {
    const metadata = didlMetadata(track);
    const setUri = await soapCall(controlUrl, 'SetAVTransportURI', setUriBody(track.url, metadata));
    const sent = setUri.ok
        ? setUri
        : await soapCall(controlUrl, 'SetAVTransportURI', setUriBody(track.url, 'NOT_IMPLEMENTED'));
    if (!sent.ok) {
        return { ok: false, reason: sent.fault || '音响拒绝了这次推送，请确认它支持 DLNA 播放' };
    }
    const play = await soapCall(controlUrl, 'Play', playBody);
    if (!play.ok) {
        return { ok: false, reason: play.fault || '地址已送出，但音响没有开始播放' };
    }
    return { ok: true };
};

const stopOnSpeaker = async controlUrl => {
    const result = await soapCall(controlUrl, 'Stop', stopBody);
    return { ok: result.ok, reason: result.ok ? '' : (result.fault || '停止失败') };
};

// ------------------------------------------------------------------ 音响音量
//
// 音量与静音在 RenderingControl 上，通道一律是 Master（少数设备叫 Master/Phone 之类，
// Master 是所有 DLNA MediaRenderer 都必须支持的）。

const getVolumeBody = '<u:GetVolume xmlns:u="' + RENDERING_CONTROL + '">'
    + '<InstanceID>0</InstanceID><Channel>Master</Channel></u:GetVolume>';

const setVolumeBody = volume => '<u:SetVolume xmlns:u="' + RENDERING_CONTROL + '">'
    + '<InstanceID>0</InstanceID><Channel>Master</Channel>'
    + `<DesiredVolume>${Math.round(volume)}</DesiredVolume></u:SetVolume>`;

const getMuteBody = '<u:GetMute xmlns:u="' + RENDERING_CONTROL + '">'
    + '<InstanceID>0</InstanceID><Channel>Master</Channel></u:GetMute>';

const setMuteBody = muted => '<u:SetMute xmlns:u="' + RENDERING_CONTROL + '">'
    + '<InstanceID>0</InstanceID><Channel>Master</Channel>'
    + `<DesiredMute>${muted ? 1 : 0}</DesiredMute></u:SetMute>`;

const readTagNumber = (text, tag) => {
    const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(text);
    if (!match) return null;
    const value = Number(match[1].trim());
    return Number.isFinite(value) ? value : null;
};

/** 读音响当前音量与静音状态。设备不支持时返回 ok:false，界面据此把音量条藏起来。 */
const getVolumeOnSpeaker = async renderingControlUrl => {
    const [volume, mute] = await Promise.all([
        soapCall(renderingControlUrl, 'GetVolume', getVolumeBody, RENDERING_CONTROL),
        soapCall(renderingControlUrl, 'GetMute', getMuteBody, RENDERING_CONTROL),
    ]);
    if (!volume.ok) {
        return { ok: false, reason: volume.fault || '这台音响不支持调节音量', volume: null, muted: null };
    }
    const current = readTagNumber(volume.body, 'CurrentVolume');
    const mutedValue = mute.ok ? readTagNumber(mute.body, 'CurrentMute') : null;
    return {
        ok: current !== null,
        reason: current === null ? '这台音响没有报告音量' : '',
        volume: current === null ? null : Math.min(100, Math.max(0, current)),
        muted: mutedValue === null ? null : mutedValue !== 0,
    };
};

const setVolumeOnSpeaker = async (renderingControlUrl, volume) => {
    const target = Math.min(100, Math.max(0, Math.round(Number(volume) || 0)));
    const result = await soapCall(renderingControlUrl, 'SetVolume', setVolumeBody(target), RENDERING_CONTROL);
    return { ok: result.ok, volume: target, reason: result.ok ? '' : (result.fault || '调节音量失败') };
};

const setMuteOnSpeaker = async (renderingControlUrl, muted) => {
    const result = await soapCall(renderingControlUrl, 'SetMute', setMuteBody(Boolean(muted)), RENDERING_CONTROL);
    return { ok: result.ok, muted: Boolean(muted), reason: result.ok ? '' : (result.fault || '切换静音失败') };
};

module.exports = {
    soapCall,
    playOnSpeaker,
    stopOnSpeaker,
    getVolumeOnSpeaker,
    setVolumeOnSpeaker,
    setMuteOnSpeaker,
    AV_TRANSPORT,
    RENDERING_CONTROL,
};
