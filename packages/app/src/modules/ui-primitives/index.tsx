import * as React from 'react';
import { useThemeStore } from '@/stores/theme-store';
import {
  Badge,
  Button,
  Card,
  CommandBar,
  EditorialHero,
  Input,
  Kbd,
  Lockup,
  Panel,
  StatCard,
  StatusDot,
  Tab,
  Tabs,
  ThemeOrbs,
  TreeItem,
  AtmosphericPanel,
} from '@/ui';
import type { ThemeId } from '@/themes';

/**
 * Visual verification surface for the @/ui primitive library. Not
 * shown on the activity bar — reachable via the command palette as
 * "Go to UI Primitives". Renders every primitive in every variant
 * against the active theme so designers + implementers can eyeball
 * coverage and color correctness across all four families.
 */
export default function UIPrimitivesSandbox(): React.JSX.Element {
  const themeId = useThemeStore((s) => s.themeId);
  const setThemeId = useThemeStore((s) => s.setThemeId);
  const [tab, setTab] = React.useState('primitives');

  return (
    <div data-testid="ui-primitives-root" style={{ padding: 48, maxWidth: 1200, margin: '0 auto' }}>
      <EditorialHero
        eyebrow="Beacon · Primitives"
        title="The vocabulary"
        titleAccent="we share"
        lede="Every block below is drawn from the @/ui library. Switch themes from the title bar to verify color correctness; everything below repaints live."
        pills={[
          { label: 'healthy', tone: 'ok' },
          { label: 'P1 · Primitives', tone: 'info' },
        ]}
      />

      <Section title="Buttons">
        <Row>
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="destructive">Destructive</Button>
        </Row>
        <Row>
          <Button variant="primary" size="sm">Small</Button>
          <Button variant="primary" size="md">Medium</Button>
          <Button variant="primary" size="lg">Large</Button>
        </Row>
      </Section>

      <Section title="Badges + StatusDots + Kbd">
        <Row>
          <Badge>default</Badge>
          <Badge variant="brand">brand</Badge>
          <Badge variant="ok">ok</Badge>
          <Badge variant="warn">warn</Badge>
          <Badge variant="err">err</Badge>
        </Row>
        <Row>
          <StatusDot tone="ok" label="healthy" />
          <StatusDot tone="warn" label="degraded" pulse />
          <StatusDot tone="err" label="down" pulse />
          <StatusDot tone="idle" label="offline" />
          <StatusDot tone="info" label="starting" pulse />
        </Row>
        <Row>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
          <Kbd>⌘⇧P</Kbd>
          <Kbd compact>⌘K</Kbd>
        </Row>
      </Section>

      <Section title="Input">
        <Input placeholder="Search…" />
        <div style={{ height: 12 }} />
        <Input placeholder="Invalid" invalid />
        <div style={{ height: 12 }} />
        <Input placeholder="Disabled" disabled />
      </Section>

      <Section title="Tabs">
        <Tabs value={tab} onValueChange={setTab}>
          <Tab value="primitives">Primitives</Tab>
          <Tab value="patterns">Patterns</Tab>
          <Tab value="tokens">Tokens</Tab>
        </Tabs>
        <p style={{ marginTop: 12, color: 'var(--color-text-secondary)' }}>
          Active tab: <code>{tab}</code>
        </p>
      </Section>

      <Section title="Tree items">
        <Panel>
          <TreeItem label="README.md" icon={<DotIcon />} active />
          <TreeItem label="color.css" icon={<DotIcon />} trailing={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--color-text-tertiary)' }}>108</span>} />
          <TreeItem label="typography.css" icon={<DotIcon />} trailing={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--color-text-tertiary)' }}>12</span>} />
          <TreeItem label="Workloads" collapsed={false} icon={<DotIcon />} />
          <TreeItem indent={1} label="wl-abc · qwen-coder" icon={<DotIcon />} trailing={<StatusDot tone="ok" />} />
          <TreeItem indent={1} label="wl-ghi · llama-70b" icon={<DotIcon />} trailing={<StatusDot tone="warn" pulse />} />
        </Panel>
      </Section>

      <Section title="StatCards">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <StatCard label="tokens / sec" value="48.2" unit="t/s" delta={{ text: '↑ 12 %', direction: 'up' }} sparkline={[10, 14, 9, 18, 22, 16, 28, 24, 32, 30, 38, 48]} />
          <StatCard label="workloads" value="3" delta={{ text: '— no change', direction: 'flat' }} />
          <StatCard label="queue depth" value="12" delta={{ text: '↓ 4', direction: 'down' }} sparkline={[20, 22, 18, 15, 14, 12, 16, 12, 10, 12]} />
          <StatCard label="nodes" value="4" unit="/6" />
        </div>
      </Section>

      <Section title="AtmosphericPanel">
        <AtmosphericPanel>
          <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontWeight: 300, fontSize: 64, letterSpacing: '-0.03em' }}>Beacon</h2>
          <p style={{ color: 'var(--color-text-secondary)', maxWidth: '50ch' }}>
            The atmospheric surface — gradient, two blurred blobs, noise overlay from tokens. Use for
            hero moments only.
          </p>
        </AtmosphericPanel>
      </Section>

      <Section title="CommandBar + ThemeOrbs">
        <Row>
          <CommandBar
            crumbs={[
              { label: 'beacon' },
              { label: 'Ops' },
              { label: 'wl-ghi', current: true },
            ]}
          />
          <ThemeOrbs activeId={themeId} onPick={(id: ThemeId) => setThemeId(id)} />
        </Row>
      </Section>

      <Section title="Lockup + Card">
        <Row>
          <Card style={{ minWidth: 240 }}>
            <Lockup />
            <p style={{ margin: '12px 0 0', color: 'var(--color-text-secondary)' }}>
              Tier-1 card surface.
            </p>
          </Card>
          <Card tier={2} style={{ minWidth: 240 }}>
            <Lockup size="sm" />
            <p style={{ margin: '12px 0 0', color: 'var(--color-text-secondary)' }}>
              Tier-2 elevated surface.
            </p>
          </Card>
        </Row>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section style={{ marginTop: 48 }}>
      <h3 style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>{children}</div>;
}

function DotIcon(): React.JSX.Element {
  return <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--color-text-tertiary)', display: 'inline-block' }} />;
}
