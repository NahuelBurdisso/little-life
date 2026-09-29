import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { homeNameCandidates, nameHomes, pickHomeName, splitName } from '../homeNames';
import { isOwnHomeWord, parsePlanBlocks } from '../planning/planParser';

function townDb(): Database.Database {
  const conn = new Database(':memory:');
  conn.exec(`
    CREATE TABLE locations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL);
    CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT NOT NULL, home INTEGER, is_active INTEGER NOT NULL);
  `);
  return conn;
}

const names = (conn: Database.Database) =>
  (conn.prepare('SELECT id, name FROM locations ORDER BY id').all() as Array<{ id: number; name: string }>)
    .map((l) => l.name);

describe('home names', () => {
  it('splits first and family names, dropping titles', () => {
    expect(splitName('Dr. Anna Petrov')).toEqual({ first: 'Anna', family: 'Petrov' });
    expect(splitName("James O'Brien")).toEqual({ first: 'James', family: "O'Brien" });
    expect(splitName('Priya')).toEqual({ first: 'Priya', family: null });
  });

  it("calls a single resident's house their cottage and a household by its family name", () => {
    expect(homeNameCandidates(['Rosa Fernandez'])[0]).toBe("Rosa's cottage");
    expect(homeNameCandidates(['Carlos Mendez'])[0]).toBe("Carlos' cottage");
    expect(homeNameCandidates(['Rosa Fernandez', 'Luis Fernandez'])[0]).toBe('the Fernandez house');
    // The first resident with a family name gives it.
    expect(homeNameCandidates(['Priya', 'Omar Haddad'])[0]).toBe('the Haddad house');
    expect(homeNameCandidates(['Priya', 'Omar'])[0]).toBe("Priya's house");
    expect(homeNameCandidates([])).toEqual([]);
  });

  it('never reuses a name another place has (case-insensitive), falling back to full names then numbers', () => {
    expect(pickHomeName(['Rosa Fernandez'], new Set(["rosa's cottage"]))).toBe("Rosa Fernandez's cottage");
    expect(pickHomeName(['Rosa'], new Set(["rosa's cottage"]))).toBe("Rosa's cottage (2)");
  });

  it('names lived-in homes at build, keeps ids, leaves vacant ones, and is idempotent', () => {
    const conn = townDb();
    conn.exec(`
      INSERT INTO locations (id, name, type) VALUES
        (1, 'Home 1', 'home'), (2, 'Home 2', 'home'), (3, 'Home 3', 'home'), (4, 'Home 4', 'home'),
        (5, 'The Rusty Lantern', 'tavern');
      INSERT INTO agents (id, name, home, is_active) VALUES
        (1, 'Elena Voss', 1, 1), (2, 'James O''Brien', 1, 1),
        (3, 'Marco Rivera', 2, 1),
        (4, 'Lucia Rivera', 3, 1), (5, 'Diego Rivera', 3, 1),
        (6, 'Ghost Person', 4, 0);
    `);
    expect(nameHomes(conn)).toBe(3);
    expect(names(conn)).toEqual([
      'the Voss house', "Marco's cottage", 'the Rivera house', 'Home 4', 'The Rusty Lantern',
    ]);
    expect(nameHomes(conn)).toBe(0);
    expect(names(conn)[0]).toBe('the Voss house');
  });

  it('the startup pass only touches houses still called Home N', () => {
    const conn = townDb();
    conn.exec(`
      INSERT INTO locations (id, name, type) VALUES (1, 'Home 1', 'home'), (2, 'the Old Mill House', 'home');
      INSERT INTO agents (id, name, home, is_active) VALUES (1, 'Rosa Fernandez', 1, 1), (2, 'Carlos Mendez', 2, 1);
    `);
    expect(nameHomes(conn, { onlyGeneric: true })).toBe(1);
    expect(names(conn)).toEqual(["Rosa's cottage", 'the Old Mill House']);
  });

  it('renames just the house someone moved into when asked to', () => {
    const conn = townDb();
    conn.exec(`
      INSERT INTO locations (id, name, type) VALUES (1, 'Home 1', 'home'), (2, 'Home 2', 'home');
      INSERT INTO agents (id, name, home, is_active) VALUES (1, 'Rosa Fernandez', 1, 1), (2, 'Carlos Mendez', 2, 1);
    `);
    nameHomes(conn);
    conn.exec("INSERT INTO agents (id, name, home, is_active) VALUES (3, 'Tomas Ortega', 1, 1)");
    expect(nameHomes(conn, { homeIds: [1] })).toBe(1);
    expect(names(conn)).toEqual(['the Fernandez house', "Carlos' cottage"]);
  });
});

describe('the own-home word in plans', () => {
  it('stays "Home" instead of substring-matching some house with "home" in its name', () => {
    expect(isOwnHomeWord('home')).toBe(true);
    expect(isOwnHomeWord('My Home')).toBe(true);
    expect(isOwnHomeWord("Rosa's home")).toBe(false);
    const blocks = parsePlanBlocks(
      '06:00-08:00 | breakfast | home\n08:00-12:00 | visit | Rosa\'s cottage\n12:00-14:00 | lunch | at home',
      ['Home 7', "Rosa's cottage", 'the Voss house'],
    );
    expect(blocks.map((b) => b.location_hint)).toEqual(['Home', "Rosa's cottage", 'Home']);
  });
});
