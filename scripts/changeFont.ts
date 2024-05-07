import * as fs from 'fs';

function changeFontInAssFile(filePath: string, fontFilePath: string, fontName: string): void {
    try {
        // Read the ASS file
        let assContent = fs.readFileSync(filePath, 'utf-8');

        // Find the Style section
        const styleSectionIndex = assContent.indexOf('[V4+ Styles]');
        if (styleSectionIndex === -1) {
            throw new Error('Style section not found in ASS file.');
        }

        // Find the Default style
        const defaultStyleIndex = assContent.indexOf('Style:', styleSectionIndex);
        if (defaultStyleIndex === -1) {
            throw new Error('Default style not found in ASS file.');
        }

        // Extract the Default style line
        let defaultStyleLine = assContent.substring(defaultStyleIndex, assContent.indexOf('\n', defaultStyleIndex));

        // Modify the Fontname attribute
        const fontNamePattern = /\,[^\,]*\,/; // Regex to match Fontname attribute
        const modifiedStyleLine = defaultStyleLine.replace(fontNamePattern, `,${fontFilePath}${fontName},`);

        // Replace the original Default style line with the modified one
        assContent = assContent.replace(defaultStyleLine, modifiedStyleLine);

        // Save the modified ASS file
        fs.writeFileSync(filePath, assContent, 'utf-8');

        console.log('Font changed successfully.');
    } catch (error) {
        console.error('Error:', error);
    }
}

// Example usage
const assFilePath = 'output.ass';
const customFontFilePath = '@/fonts/the_bold_font.ttf';
const customFontName = 'CustomFontName';

changeFontInAssFile(assFilePath, customFontFilePath, customFontName);
