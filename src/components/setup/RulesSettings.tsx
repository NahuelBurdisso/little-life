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
        <div className="text-sm text-ui-text">{param.label}</div>
        <div className="text-[10px] text-ui-muted">{param.description}</div>
      </div>
      <button onClick={() => onChange(!value)}
        className={`w-10 h-5 rounded-full transition-colors ${value ? 'bg-ui-gold' : 'bg-ui-hover'}`}>
        <div className={`w-4 h-4 bg-ui-deep rounded-full transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );
}

function SliderControl({ param, value, onChange }: { param: ConfigParam; value: number; onChange: (v: number) => void }) {
  const displayValue = param.unit ? `${value}${param.unit}` : String(value);
  return (
    <div className="py-1">
      <div className="flex items-center justify-between mb-1">
        <div className="text-sm text-ui-text">{param.label}</div>
        <div className="text-xs text-ui-dim">{displayValue}</div>
      </div>
      <div className="text-[10px] text-ui-muted mb-1.5">{param.description}</div>
      <input type="range"
        min={param.min} max={param.max} step={param.step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full accent-ui-gold" />
      <div className="flex justify-between text-[9px] text-ui-muted">
        <span>{param.min}{param.unit ?? ''}</span>
        <span>{param.max}{param.unit ?? ''}</span>
      </div>
    </div>
  );
}

function SelectControl({ param, value, onChange }: { param: ConfigParam; value: string; onChange: (v: string) => void }) {
  return (
    <div className="py-1">
      <div className="text-sm text-ui-text mb-0.5">{param.label}</div>
      <div className="text-[10px] text-ui-muted mb-1.5">{param.description}</div>
      <div className="flex gap-1">
        {(param.options ?? []).map(o => (
          <button key={o} onClick={() => onChange(o)}
            className={`flex-1 py-1.5 text-xs rounded-md capitalize transition-colors ${
              value === o
                ? 'bg-ui-gold/10 border border-ui-gold text-ui-text'
                : 'bg-ui-panel border border-ui-line text-ui-dim hover:border-ui-line-accent'
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
      <div className="text-sm text-ui-text mb-0.5">{param.label}</div>
      <div className="text-[10px] text-ui-muted mb-1.5">{param.description}</div>
      <input value={value} onChange={e => onChange(e.target.value)}
        className="w-full bg-ui-deep border border-ui-line rounded-lg px-3 py-2 text-sm text-ui-text" />
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
              <h3 className="text-xs text-ui-muted uppercase font-medium">{icon} {label}</h3>
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
