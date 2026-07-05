/**
 * Tanzanian curriculum subject presets (TIE syllabi). Codes follow common
 * school shorthand; names carry EN + SW so report cards can render either.
 */
export interface SubjectPreset {
  code: string;
  name: string;
  nameSw: string;
}

export const SUBJECT_PRESETS: Record<string, SubjectPreset[]> = {
  primary: [
    { code: 'KIS', name: 'Kiswahili', nameSw: 'Kiswahili' },
    { code: 'ENG', name: 'English Language', nameSw: 'Kiingereza' },
    { code: 'MAT', name: 'Mathematics', nameSw: 'Hisabati' },
    { code: 'SCI', name: 'Science and Technology', nameSw: 'Sayansi na Teknolojia' },
    { code: 'SST', name: 'Social Studies', nameSw: 'Maarifa ya Jamii' },
    { code: 'CME', name: 'Civic and Moral Education', nameSw: 'Uraia na Maadili' },
    { code: 'VSK', name: 'Vocational Skills', nameSw: 'Stadi za Kazi' },
    { code: 'REL', name: 'Religious Education', nameSw: 'Elimu ya Dini' },
  ],
  o_level: [
    { code: 'CIV', name: 'Civics', nameSw: 'Uraia' },
    { code: 'HIS', name: 'History', nameSw: 'Historia' },
    { code: 'GEO', name: 'Geography', nameSw: 'Jiografia' },
    { code: 'KIS', name: 'Kiswahili', nameSw: 'Kiswahili' },
    { code: 'ENG', name: 'English Language', nameSw: 'Kiingereza' },
    { code: 'PHY', name: 'Physics', nameSw: 'Fizikia' },
    { code: 'CHE', name: 'Chemistry', nameSw: 'Kemia' },
    { code: 'BIO', name: 'Biology', nameSw: 'Baiolojia' },
    { code: 'BAM', name: 'Basic Mathematics', nameSw: 'Hisabati' },
    { code: 'BKP', name: 'Book-keeping', nameSw: 'Uwekaji Hesabu' },
    { code: 'COM', name: 'Commerce', nameSw: 'Biashara' },
    { code: 'ICS', name: 'Information and Computer Studies', nameSw: 'TEHAMA' },
  ],
  a_level: [
    { code: 'GS', name: 'General Studies', nameSw: 'Maarifa ya Jumla' },
    { code: 'PHY', name: 'Physics', nameSw: 'Fizikia' },
    { code: 'CHE', name: 'Chemistry', nameSw: 'Kemia' },
    { code: 'BIO', name: 'Biology', nameSw: 'Baiolojia' },
    { code: 'ADM', name: 'Advanced Mathematics', nameSw: 'Hisabati ya Juu' },
    { code: 'HIS', name: 'History', nameSw: 'Historia' },
    { code: 'GEO', name: 'Geography', nameSw: 'Jiografia' },
    { code: 'ECO', name: 'Economics', nameSw: 'Uchumi' },
    { code: 'KIS', name: 'Kiswahili', nameSw: 'Kiswahili' },
    { code: 'ENG', name: 'English Language', nameSw: 'Kiingereza' },
  ],
};
