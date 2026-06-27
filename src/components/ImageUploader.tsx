/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState } from 'react';
import { Upload, Camera, Sparkles, Image as ImageIcon } from 'lucide-react';

interface ImageUploaderProps {
  onImageSelected: (dataUrl: string) => void;
}

export default function ImageUploader({ onImageSelected }: ImageUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      loadImageFile(file);
    }
    e.target.value = '';
  };

  const loadImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result && typeof event.target.result === 'string') {
        onImageSelected(event.target.result);
      }
    };
    reader.readAsDataURL(file);
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
      loadImageFile(file);
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

    onImageSelected(canvas.toDataURL());
  };

  return (
    <div className="w-full max-w-xl mx-auto flex flex-col items-center justify-center p-4">
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
        className={`w-full aspect-[4/3] rounded-2xl border-2 border-dashed flex flex-col items-center justify-center p-6 text-center cursor-pointer transition-all ${
          isDragging
            ? 'border-neutral-900 bg-neutral-50 scale-[1.01]'
            : 'border-neutral-200 hover:border-neutral-400 bg-white hover:bg-neutral-50/50'
        }`}
      >
        <div className="w-14 h-14 rounded-full bg-neutral-50 flex items-center justify-center mb-4 border border-neutral-100 shadow-sm">
          <Upload className="w-6 h-6 text-neutral-600" />
        </div>
        <h3 className="font-semibold text-neutral-800 text-lg mb-1">
          Загрузите изображение с ассетами
        </h3>
        <p className="text-neutral-500 text-sm max-w-xs mb-4">
          Перетащите файл сюда или нажмите для выбора из галереи
        </p>
        <span className="text-xs text-neutral-400 bg-neutral-50 border border-neutral-100 rounded-full px-3 py-1 font-mono">
          PNG, JPG, SVG, WebP
        </span>
      </div>

      {/* Mobile-Friendly Helper Actions */}
      <div className="grid grid-cols-2 gap-3 w-full mt-4">
        <button
          id="btn-upload-file"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center justify-center gap-2 py-3.5 px-4 bg-white border border-neutral-200 text-neutral-700 hover:text-neutral-900 hover:border-neutral-300 rounded-xl font-medium text-sm transition-all shadow-sm active:scale-95"
        >
          <ImageIcon className="w-4 h-4 text-neutral-500" />
          Выбрать файл
        </button>

        <button
          id="btn-upload-camera"
          onClick={() => cameraInputRef.current?.click()}
          className="flex items-center justify-center gap-2 py-3.5 px-4 bg-neutral-900 hover:bg-neutral-800 text-white rounded-xl font-medium text-sm transition-all shadow-md active:scale-95"
        >
          <Camera className="w-4 h-4" />
          Сделать фото
        </button>
      </div>

      {/* Instant Demo Templates Row */}
      <div className="w-full mt-8 border-t border-neutral-100 pt-6">
        <div className="flex items-center gap-1.5 justify-center mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-400">
          <Sparkles className="w-3.5 h-3.5 text-neutral-400" />
          Быстрый тест без загрузки своих файлов
        </div>
        <div className="flex flex-col sm:flex-row gap-2.5 justify-center w-full">
          <button
            id="demo-sheet-1"
            onClick={() => loadDemoSheet('modern-icons')}
            className="flex-1 py-2.5 px-3.5 bg-white hover:bg-neutral-50 border border-neutral-200 hover:border-neutral-300 text-neutral-700 rounded-xl text-xs font-medium transition-all shadow-sm flex items-center justify-center gap-2"
          >
            <div className="flex gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 block"></span>
              <span className="w-2.5 h-2.5 rounded-full bg-blue-500 block"></span>
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 block"></span>
            </div>
            Лист иконок (Белый фон)
          </button>
          <button
            id="demo-sheet-2"
            onClick={() => loadDemoSheet('color-logos')}
            className="flex-1 py-2.5 px-3.5 bg-white hover:bg-neutral-50 border border-neutral-200 hover:border-neutral-300 text-neutral-700 rounded-xl text-xs font-medium transition-all shadow-sm flex items-center justify-center gap-2"
          >
            <div className="flex gap-1">
              <span className="w-2.5 h-2.5 rounded bg-cyan-500 block"></span>
              <span className="w-2.5 h-2.5 rounded bg-violet-500 block"></span>
              <span className="w-2.5 h-2.5 rounded bg-pink-500 block"></span>
            </div>
            Лист логотипов (Светлый фон)
          </button>
        </div>
      </div>
    </div>
  );
}
