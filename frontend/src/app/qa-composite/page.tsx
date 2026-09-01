'use client';

import { useState } from 'react';
import { AdvancedRepaintCompositeEditor, type RepaintCompositeEditTool } from '@/components/advanced-repaint/AdvancedRepaintCompositeEditor';
import type { RepaintRegion } from '@/components/advanced-repaint/types';

const source = '/qa-composite/source.png';
const generated = '/qa-composite/generated.png';
const mask = '/qa-composite/mask.png';

const initial: RepaintRegion = {
  id: 'region-1', name: '区域 1', order: 0, pixelCount: 1000,
  tightBounds: { x: 270, y: 190, width: 260, height: 220 },
  cropBounds: { x: 240, y: 160, width: 320, height: 280 },
  sourceCropDataUrl: source, maskDataUrl: mask,
  prompt: 'test', referenceRole: 'general', references: [],
  candidates: [{ id: 'candidate-1', imageUrl: generated }], selectedCandidateId: 'candidate-1',
  status: 'completed', enabled: true,
};

export default function QaCompositePage() {
  const [region, setRegion] = useState(initial);
  const [tool, setTool] = useState<RepaintCompositeEditTool>('move');
  return <main className="min-h-screen bg-slate-950 p-8 text-white">
    <div className="mb-4 flex gap-2">
      {(['move','mask-add','mask-erase'] as const).map(value => <button key={value} onClick={() => setTool(value)} className={`rounded px-4 py-2 ${tool === value ? 'bg-cyan-600' : 'bg-slate-700'}`}>{value}</button>)}
    </div>
    <div className="relative h-[600px] w-[800px] overflow-hidden rounded-xl border border-slate-600">
      <AdvancedRepaintCompositeEditor sourceDataUrl={source} sourceWidth={800} sourceHeight={600} regions={[region]} selectedRegionId={region.id} blendRadius={2} editTool={tool} brushSize={48} onUpdateRegion={(_, patch) => setRegion(current => ({...current,...patch}))}/>
    </div>
    <pre data-testid="state" className="mt-4 rounded bg-slate-900 p-3">{JSON.stringify({offsetX:region.patchOffsetX||0,offsetY:region.patchOffsetY||0,maskEdited:Boolean(region.compositeMaskDataUrl)})}</pre>
  </main>;
}
