import { getCategories, getParamsByCategory, getCategoryLabel } from './configRegistry';
import type { ConfigParam } from './configRegistry';

interface Props {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}

function ToggleControl({ param, value, onChange }: { param: ConfigParam; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-1">
      <div>
        <div className="text-sm text-white">{param.label}</div>
        <div className="text-[10px] text-gray-500">{param.description}</div>
      </div>
      <button onClick={() => onChange(!value)}
        className={`w-10 h-5 rounded-full transition-colors ${value ? 'bg-blue-500' : 'bg-gray-600'}`}>
        <div className={`w-4 h-4 bg-white rounded-full transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );
}

function SliderControl({ param, value, onChange }: { param: ConfigParam; value: number; onChange: (v: number) => void }) {
  const displayValue = param.unit ? `${value}${param.unit}` : String(value);
  return (
    <div className="py-1">
      <div className="flex items-center justify-between mb-1">
        <div className="text-sm text-white">{param.label}</div>
        <div className="text-xs text-gray-400">{displayValue}</div>
      </div>
      <div className="text-[10px] text-gray-500 mb-1.5">{param.description}</div>
      <input type="range"
        min={param.min} max={param.max} step={param.step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full accent-blue-500" />
      <div className="flex justify-between text-[9px] text-gray-600">
        <span>{param.min}{param.unit ?? ''}</span>
        <span>{param.max}{param.unit ?? ''}</span>
      </div>
    </div>
  );
}

function SelectControl({ param, value, onChange }: { param: ConfigParam; value: string; onChange: (v: string) => void }) {
  return (
    <div className="py-1">
      <div className="text-sm text-white mb-0.5">{param.label}</div>
      <div className="text-[10px] text-gray-500 mb-1.5">{param.description}</div>
      <div className="flex gap-1">
        {(param.options ?? []).map(o => (
          <button key={o} onClick={() => onChange(o)}
            className={`flex-1 py-1.5 text-xs rounded-md capitalize transition-colors ${
              value === o
                ? 'bg-blue-600/20 border border-blue-500 text-white'
                : 'bg-gray-800 border border-gray-700 text-gray-400 hover:border-gray-500'
            }`}>
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

function TextControl({ param, value, onChange }: { param: ConfigParam; value: string; onChange: (v: string) => void }) {
  return (
    <div className="py-1">
      <div className="text-sm text-white mb-0.5">{param.label}</div>
      <div className="text-[10px] text-gray-500 mb-1.5">{param.description}</div>
      <input value={value} onChange={e => onChange(e.target.value)}
        className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white" />
    </div>
  );
}

function ConfigControl({ param, value, onChange }: { param: ConfigParam; value: any; onChange: (v: any) => void }) {
  switch (param.type) {
    case 'toggle': return <ToggleControl param={param} value={value as boolean} onChange={onChange} />;
    case 'slider': return <SliderControl param={param} value={value as number} onChange={onChange} />;
    case 'select': return <SelectControl param={param} value={value as string} onChange={onChange} />;
    case 'text': return <TextControl param={param} value={value as string} onChange={onChange} />;
  }
}

export function RulesSettings({ config, onChange }: Props) {
  const update = (key: string, value: any) => onChange({ ...config, [key]: value });

  const categories = getCategories();

  return (
    <div>
      <h2 className="text-lg font-bold mb-6">⚙️ Rules & Simulation</h2>

      <div className="grid grid-cols-2 gap-8 max-w-2xl">
        {categories.map(cat => {
          const { label, icon } = getCategoryLabel(cat);
          const params = getParamsByCategory(cat);
          return (
            <div key={cat} className="space-y-4">
              <h3 className="text-xs text-gray-500 uppercase font-medium">{icon} {label}</h3>
              {params.map(param => (
                <ConfigControl
                  key={param.key}
                  param={param}
                  value={config[param.key] ?? param.default}
                  onChange={(v) => update(param.key, v)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
