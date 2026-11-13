// src/components/visualizer/kinetic/saveExportFile.ts
// 文字PV 导出落盘：把原版编辑器生成的 Blob（MP4 / PNG 序列 zip / AE 数据）交给浏览器下载。
//
// 原版是安卓工程，导出走 Capacitor 原生 saveFile（ACTION_CREATE_DOCUMENT 弹保存位置选择器）。
// 自用版只跑桌面 Electron，这里去掉 @capacitor/* 依赖，只保留普通下载分支 ——
// 行为和原版桌面路径一致：点导出直接下载到系统下载目录。

export type SaveExportResult = 'saved' | 'cancelled';

/**
 * 保存导出文件，返回用户是存了还是取消了。
 *
 * 桌面：把 base64 解成字节再挂 object URL 触发下载，不必把几十 MB 串进 DOM。
 */
export const saveExportFile = async (input: {
    filename: string;
    base64: string;
    mime: string;
}): Promise<SaveExportResult> => {
    const { filename, base64, mime } = input;

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    return 'saved';
};
