import { describe, it, expect } from 'vitest';
import { JOBS, JOB_OPTIONS, WAGE_FLOOR, jobSalary, jobWorkplaceType } from '../jobs';
import { AGENT_SEEDS } from '../agents';
import { CONFIG } from '../../lib/constants';
import { getDefaultAgents } from '../../../src/components/setup/defaults';

/**
 * E9: a job's wage is defined once (data/jobs.ts). The seeds, the wizard defaults and the wizard's
 * job dropdown all derive from it, so these can only fail if someone reintroduces a second table.
 */
describe('job table', () => {
  it('no job pays under the wage floor, and the floor is the one CONFIG uses', () => {
    expect(CONFIG.ECONOMY.WAGE_FLOOR).toBe(WAGE_FLOOR);
    for (const [job, def] of Object.entries(JOBS)) {
      expect(def.salary, job).toBeGreaterThanOrEqual(WAGE_FLOOR);
    }
  });

  it('every seed is paid its job\'s wage', () => {
    expect(AGENT_SEEDS.length).toBeGreaterThan(0);
    for (const seed of AGENT_SEEDS) {
      expect(seed.job in JOBS, `${seed.name}: unknown job ${seed.job}`).toBe(true);
      expect(seed.salary, seed.name).toBe(jobSalary(seed.job));
    }
  });

  it('the wizard defaults match the seeds, name for name', () => {
    const wizard = getDefaultAgents();
    expect(wizard).toHaveLength(AGENT_SEEDS.length);
    for (const seed of AGENT_SEEDS) {
      const w = wizard.find((a) => a.name === seed.name);
      expect(w, seed.name).toBeDefined();
      expect(w!.job, seed.name).toBe(seed.job);
      expect(w!.salary, seed.name).toBe(seed.salary);
    }
  });

  it('the wizard dropdown is the table, one option per job', () => {
    expect(JOB_OPTIONS.map((o) => o.job)).toEqual(Object.keys(JOBS));
    for (const o of JOB_OPTIONS) expect(o.salary).toBe(JOBS[o.job].salary);
  });

  it('an unknown or free-text job earns the floor and has no fixed workplace', () => {
    expect(jobSalary('astronaut')).toBe(WAGE_FLOOR);
    expect(jobSalary('unemployed')).toBe(WAGE_FLOOR);
    expect(jobSalary(' Doctor ')).toBe(JOBS.doctor.salary);
    expect(jobSalary('toString')).toBe(WAGE_FLOOR); // not an inherited property
    expect(jobWorkplaceType('astronaut')).toBeNull();
    expect(jobWorkplaceType('retired')).toBeNull();
    expect(jobWorkplaceType('Baker')).toBe('bakery');
  });
});
