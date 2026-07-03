/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState } from 'react';
import { Upload, Camera, Sparkles, Image as ImageIcon } from 'lucide-react';

interface ImageUploaderProps {
  onImageSelected: (file: File) => void;
  useAIBgRemoval: boolean;
  onUseAIBgRemovalChange: (val: boolean) => void;
  localModel: string;
  onOpenSettings: () => void;
}

export default function ImageUploader({
  onImageSelected,
  useAIBgRemoval,
  onUseAIBgRemovalChange,
  localModel,
  onOpenSettings
}: ImageUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onImageSelected(file);
    }
    e.target.value = '';
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = () => {
    setIsDragging(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      onImageSelected(file);
    }
  };

  // Dynamically generate a beautiful mock sprite sheet on canvas for instant testing!
  const loadDemoSheet = (theme: 'modern-icons' | 'color-logos') => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 400;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (theme === 'modern-icons') {
      // White background sheet with 3 clean icons for cutting
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw Icon 1: Red Heart (left)
      ctx.save();
      ctx.translate(180, 200);
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      // Draw standard heart
      ctx.moveTo(0, -30);
      ctx.bezierCurveTo(20, -60, 60, -30, 0, 30);
      ctx.bezierCurveTo(-60, -30, -20, -60, 0, -30);
      ctx.fill();
      // Tag/label below
      ctx.fillStyle = '#1e293b';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('HEART', 0, 70);
      ctx.restore();

      // Draw Icon 2: Blue Star (middle)
      ctx.save();
      ctx.translate(400, 200);
      ctx.fillStyle = '#3b82f6';
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        ctx.lineTo(Math.cos(((18 + i * 72) * Math.PI) / 180) * 50, -Math.sin(((18 + i * 72) * Math.PI) / 180) * 50);
        ctx.lineTo(Math.cos(((54 + i * 72) * Math.PI) / 180) * 20, -Math.sin(((54 + i * 72) * Math.PI) / 180) * 20);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#1e293b';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('STAR', 0, 70);
      ctx.restore();

      // Draw Icon 3: Green Diamond (right)
      ctx.save();
      ctx.translate(620, 200);
      ctx.fillStyle = '#10b981';
      ctx.beginPath();
      ctx.moveTo(0, -50);
      ctx.lineTo(40, 0);
      ctx.lineTo(0, 50);
      ctx.lineTo(-40, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#1e293b';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('GEM', 0, 70);
      ctx.restore();

    } else {
      // Color Logos sheet with soft gray background and 2 compound multi-colored elements
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Element 1: Multi-ring target logo (left)
      ctx.save();
      ctx.translate(250, 200);
      // Outer teal ring
      ctx.fillStyle = '#06b6d4';
      ctx.beginPath();
      ctx.arc(0, 0, 50, 0, Math.PI * 2);
      ctx.arc(0, 0, 35, 0, Math.PI * 2, true);
      ctx.fill();
      // Inner orange dot
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.arc(0, 0, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1e293b';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Logo A', 0, 80);
      ctx.restore();

      // Element 2: Stacked tech triangles (right)
      ctx.save();
      ctx.translate(550, 200);
      // Purple triangle
      ctx.fillStyle = '#8b5cf6';
      ctx.beginPath();
      ctx.moveTo(-45, 30);
      ctx.lineTo(45, 30);
      ctx.lineTo(0, -45);
      ctx.closePath();
      ctx.fill();
      // Inverted pink triangle overlapping
      ctx.fillStyle = '#ec4899';
      ctx.beginPath();
      ctx.moveTo(-25, -25);
      ctx.lineTo(25, -25);
      ctx.lineTo(0, 25);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#1e293b';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Logo B', 0, 80);
      ctx.restore();
    }

    canvas.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], 'demo.png', { type: 'image/png' });
        onImageSelected(file);
      }
    }, 'image/png');
  };

  return (
    <div className="w-full max-w-xl mx-auto flex flex-col items-center justify-center p-4 font-sans">
      {/* File Inputs (hidden) */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept="image/*"
        className="hidden"
        id="file-upload"
      />
      <input
        type="file"
        ref={cameraInputRef}
        onChange={handleFileChange}
        accept="image/*"
        capture="environment"
        className="hidden"
        id="camera-upload"
      />

      {/* Main Drag-Drop / Upload Area */}
      <div
        id="uploader-dropzone"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`w-full aspect-[4/3] rounded-3xl border-2 border-dashed flex flex-col items-center justify-center p-8 text-center cursor-pointer transition-all duration-300 relative overflow-hidden group ${
          isDragging
            ? 'border-violet-500 bg-zinc-900/80 scale-[1.01] shadow-[0_0_25px_rgba(139,92,246,0.15)]'
            : 'border-zinc-800 hover:border-zinc-700 bg-zinc-900/30 hover:bg-zinc-900/50 shadow-xl'
        }`}
      >
        {/* Subtle decorative glow */}
        <div className="absolute -inset-10 bg-gradient-to-tr from-violet-500/10 via-transparent to-emerald-500/10 opacity-30 blur-2xl group-hover:opacity-50 transition-opacity duration-500 pointer-events-none" />

        <div className="w-16 h-16 rounded-2xl bg-zinc-900/80 border border-zinc-800 flex items-center justify-center mb-5 shadow-md group-hover:scale-105 group-hover:border-zinc-700 transition-all duration-300 group-hover:shadow-[0_0_15px_rgba(139,92,246,0.1)]">
          <Upload className="w-6 h-6 text-zinc-400 group-hover:text-violet-400 transition-colors duration-300" />
        </div>
        <h3 className="font-bold text-zinc-100 text-lg sm:text-xl mb-2 tracking-tight group-hover:text-white transition-colors duration-300">
          Загрузите лист с ассетами
        </h3>
        <p className="text-zinc-400 text-sm max-w-xs mb-5 leading-relaxed">
          Перетащите файл сюда или нажмите для выбора из галереи
        </p>
        <span className="text-xs text-zinc-400 bg-zinc-950/80 border border-zinc-800 rounded-full px-4.5 py-1.5 font-mono tracking-wide shadow-inner">
          PNG, JPG, SVG, WebP
        </span>
      </div>

      {/* Mobile-Friendly Helper Actions */}
      <div className="grid grid-cols-2 gap-3.5 w-full mt-5">
        <button
          id="btn-upload-file"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center justify-center gap-2.5 py-3.5 px-4 bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-300 hover:text-zinc-100 rounded-2xl font-semibold text-sm transition-all duration-300 shadow-md hover:shadow-lg active:scale-98 cursor-pointer"
        >
          <ImageIcon className="w-4 h-4 text-zinc-400" />
          Выбрать файл
        </button>

        <button
          id="btn-upload-camera"
          onClick={() => cameraInputRef.current?.click()}
          className="flex items-center justify-center gap-2.5 py-3.5 px-4 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white rounded-2xl font-semibold text-sm transition-all duration-300 shadow-[0_4px_12px_rgba(124,58,237,0.2)] hover:shadow-[0_4px_20px_rgba(124,58,237,0.35)] active:scale-98 cursor-pointer"
        >
          <Camera className="w-4 h-4" />
          Сделать фото
        </button>
      </div>

      {/* AI Background Removal Toggle */}
      <div className="w-full mt-5 bg-zinc-900/40 border border-zinc-800/80 rounded-2xl p-4.5 flex items-center justify-between shadow-md backdrop-blur-md relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-violet-500/5 to-transparent pointer-events-none" />
        <div className="flex flex-col gap-1 pr-3 relative z-10">
          <span className="text-sm font-bold text-zinc-200 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-violet-400 shrink-0" />
            Авто-удаление фона через AI
          </span>
          <p className="text-xs text-zinc-400 leading-relaxed max-w-sm">
            Автоматически вырежет фон нейросетью прямо при загрузке.
          </p>
        </div>
        <button
          onClick={() => onUseAIBgRemovalChange(!useAIBgRemoval)}
          type="button"
          className={`w-11 h-6.5 flex items-center rounded-full p-1 transition-all duration-300 shrink-0 cursor-pointer ${
            useAIBgRemoval ? 'bg-violet-600 shadow-[0_0_10px_rgba(124,58,237,0.3)] justify-end' : 'bg-zinc-800 justify-start'
          }`}
        >
          <span className="w-4.5 h-4.5 rounded-full bg-white shadow-md transition-all duration-300" />
        </button>
      </div>

      {/* AI Model Selector / Status block linking to settings */}
      {useAIBgRemoval && (
        <div className="w-full mt-4 bg-zinc-900/40 border border-zinc-800/80 rounded-2xl p-4.5 flex flex-col gap-3 shadow-md backdrop-blur-md animate-in fade-in duration-300">
          <div className="flex justify-between items-center text-xs">
            <span className="font-bold text-zinc-300 uppercase tracking-wider">ИИ модель удаления фона</span>
            <button
              type="button"
              onClick={onOpenSettings}
              className="text-violet-400 hover:text-violet-300 font-bold flex items-center gap-1 transition-all cursor-pointer hover:underline"
            >
              Настроить
            </button>
          </div>
          <div className="flex items-center justify-between bg-zinc-950/60 border border-zinc-800/60 rounded-xl p-3">
            <span className="font-medium text-zinc-400">
              Локальный ИИ (Автономно)
            </span>
            <span className="bg-zinc-900 border border-zinc-800 text-zinc-300 px-2.5 py-1 rounded-lg font-mono text-[11px] font-bold">
              {localModel}
            </span>
          </div>
        </div>
      )}

      {/* Instant Demo Templates Row */}
      <div className="w-full mt-10 border-t border-zinc-800/85 pt-8">
        <div className="flex items-center gap-2 justify-center mb-4 text-xs font-bold uppercase tracking-wider text-zinc-500">
          <Sparkles className="w-3.5 h-3.5 text-zinc-500" />
          Быстрый тест без загрузки своих файлов
        </div>
        <div className="flex flex-col sm:flex-row gap-3 justify-center w-full">
          <button
            id="demo-sheet-1"
            onClick={() => loadDemoSheet('modern-icons')}
            className="flex-1 py-3 px-4 bg-zinc-900/50 hover:bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 hover:text-zinc-100 rounded-2xl text-xs font-semibold transition-all duration-300 shadow-sm flex items-center justify-center gap-2.5 active:scale-98 cursor-pointer"
          >
            <div className="flex gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-500 block shadow-[0_0_6px_rgba(244,63,94,0.4)]"></span>
              <span className="w-2.5 h-2.5 rounded-full bg-sky-500 block shadow-[0_0_6px_rgba(14,165,233,0.4)]"></span>
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 block shadow-[0_0_6px_rgba(16,185,129,0.4)]"></span>
            </div>
            Лист иконок (Белый фон)
          </button>
          <button
            id="demo-sheet-2"
            onClick={() => loadDemoSheet('color-logos')}
            className="flex-1 py-3 px-4 bg-zinc-900/50 hover:bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 hover:text-zinc-100 rounded-2xl text-xs font-semibold transition-all duration-300 shadow-sm flex items-center justify-center gap-2.5 active:scale-98 cursor-pointer"
          >
            <div className="flex gap-1.5">
              <span className="w-2.5 h-2.5 rounded bg-cyan-500 block shadow-[0_0_6px_rgba(6,182,212,0.4)]"></span>
              <span className="w-2.5 h-2.5 rounded bg-violet-500 block shadow-[0_0_6px_rgba(139,92,246,0.4)]"></span>
              <span className="w-2.5 h-2.5 rounded bg-pink-500 block shadow-[0_0_6px_rgba(236,72,153,0.4)]"></span>
            </div>
            Лист логотипов (Светлый фон)
          </button>
        </div>
      </div>
    </div>
  );
}
