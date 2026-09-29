/**
 * Names for strangers who move to town on their own (lib/populationFlow.ts).
 *
 * The worldgen `names` stage that was meant to name things is still a stub
 * (lib/worldgen/stages/names.ts returns every name unchanged), and the prompts
 * set the town around 1900 (ai/setting.ts) — a "Jayden" or a "Madison" walking
 * up the road would break it. So: first names common in the English-speaking
 * world of the 1880s-1900s, and family names from the mix of people such a
 * town drew in.
 *
 * Pure data, no Node/DB imports.
 */

export const PERIOD_FIRST_NAMES = {
  female: [
    'Ada', 'Agnes', 'Alma', 'Bertha', 'Bessie', 'Clara', 'Cora', 'Daisy', 'Edith', 'Effie',
    'Eliza', 'Ella', 'Elsie', 'Emma', 'Esther', 'Etta', 'Florence', 'Hattie', 'Ida', 'Ivy',
    'Josephine', 'Lena', 'Lillian', 'Lottie', 'Louisa', 'Mabel', 'Mae', 'Martha', 'Matilda', 'Maud',
    'Minnie', 'Nellie', 'Nora', 'Olive', 'Opal', 'Pearl', 'Ruby', 'Stella', 'Violet', 'Winifred',
  ],
  male: [
    'Abel', 'Albert', 'Alfred', 'Amos', 'Archie', 'Arthur', 'Augustus', 'Bert', 'Calvin', 'Cecil',
    'Clarence', 'Cyrus', 'Edgar', 'Elmer', 'Ernest', 'Ezra', 'Floyd', 'Frederick', 'Harold', 'Herbert',
    'Homer', 'Horace', 'Hugh', 'Jasper', 'Lester', 'Lloyd', 'Luther', 'Milton', 'Morris', 'Oscar',
    'Otis', 'Percy', 'Roscoe', 'Rufus', 'Silas', 'Stanley', 'Virgil', 'Walter', 'Wilbur', 'Willis',
  ],
} as const;

export const PERIOD_FAMILY_NAMES = [
  'Abbott', 'Ashby', 'Barlow', 'Bramwell', 'Calloway', 'Carver', 'Doyle', 'Dunmore', 'Ellery', 'Fenwick',
  'Finch', 'Garrity', 'Haskins', 'Holloway', 'Kessler', 'Lindqvist', 'Lowry', 'Marchetti', 'McCready', 'Merritt',
  'Novak', "O'Hara", 'Pembrook', 'Pickett', 'Quinlan', 'Radford', 'Rourke', 'Schaefer', 'Shelby', 'Sorensen',
  'Stroud', 'Talbot', 'Thorne', 'Tolliver', 'Underhill', 'Vance', 'Whitlock', 'Winslow', 'Yates', 'Zimmer',
] as const;
