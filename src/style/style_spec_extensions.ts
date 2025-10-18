import {latest as styleSpec, FormatExpression, Formatted, FormattedSection} from '@maplibre/maplibre-gl-style-spec';
import {
    NumberType,
    ValueType,
    StringType,
    ColorType,
    ResolvedImageType,
    array
} from '@maplibre/maplibre-gl-style-spec/src/expression/types.js';
import {valueToString, typeOf} from '@maplibre/maplibre-gl-style-spec/src/expression/values.js';
import {isValidTextRotationAlignment} from '../symbol/text_rotation_alignment';

const layoutSymbol = styleSpec['layout_symbol'] as Record<string, any>;
const paintSymbol = styleSpec['paint_symbol'] as Record<string, any>;
const clones: Array<[string, string]> = [
    ['text-field', 'text-field2'],
    ['text-anchor', 'text-field2-anchor'],
    ['text-offset', 'text-field2-offset'],
    ['text-radial-offset', 'text-field2-radial-offset'],
    ['text-size', 'text-field2-size']
];

if (layoutSymbol) {
    for (const [source, target] of clones) {
        if (!layoutSymbol[target] && layoutSymbol[source]) {
            layoutSymbol[target] = {
                ...layoutSymbol[source],
                name: target
            };
        }
    }
}

if (paintSymbol) {
    const haloOverrides = ['text-halo-color', 'text-halo-width', 'text-halo-blur'];
    for (const property of haloOverrides) {
        const spec = paintSymbol[property];
        if (!spec) {
            continue;
        }
        spec.overridable = true;
        const requires = new Set(spec.requires || []);
        requires.add('text-field');
        requires.add('text-field2');
        spec.requires = Array.from(requires);
    }
}

const formatSectionsPrototype = FormattedSection.prototype as any;
if (formatSectionsPrototype.textHaloColor === undefined) {
    formatSectionsPrototype.textHaloColor = null;
}
if (formatSectionsPrototype.textHaloWidth === undefined) {
    formatSectionsPrototype.textHaloWidth = null;
}
if (formatSectionsPrototype.textHaloBlur === undefined) {
    formatSectionsPrototype.textHaloBlur = null;
}

type ExtendedFormattedSectionExpression = {
    content: any;
    scale: any;
    font: any;
    textColor: any;
    textHaloColor: any;
    textHaloWidth: any;
    textHaloBlur: any;
    verticalAlign: any;
    textRotationAlignment: any;
};

const FormatExpressionClass = FormatExpression as any;

FormatExpressionClass.parse = function(args: ReadonlyArray<unknown>, context: any) {
    if (args.length < 2) {
        return context.error('Expected at least one argument.') as null;
    }

    const firstArg = args[1];
    if (!Array.isArray(firstArg) && typeof firstArg === 'object') {
        return context.error('First argument must be an image or text section.') as null;
    }

    const sections: Array<ExtendedFormattedSectionExpression> = [];
    let nextTokenMayBeObject = false;
    for (let i = 1; i <= args.length - 1; ++i) {
        const arg = args[i] as any;

        if (nextTokenMayBeObject && typeof arg === 'object' && !Array.isArray(arg)) {
            nextTokenMayBeObject = false;

            let scale = null;
            if (arg['font-scale'] !== undefined) {
                scale = context.parse(arg['font-scale'], 1, NumberType);
                if (!scale) return null;
            }

            let font = null;
            if (arg['text-font'] !== undefined) {
                font = context.parse(arg['text-font'], 1, array(StringType));
                if (!font) return null;
            }

            let textColor = null;
            if (arg['text-color'] !== undefined) {
                textColor = context.parse(arg['text-color'], 1, ColorType);
                if (!textColor) return null;
            }

            let textHaloColor = null;
            if (arg['text-halo-color'] !== undefined) {
                textHaloColor = context.parse(arg['text-halo-color'], 1, ColorType);
                if (!textHaloColor) return null;
            }

            let textHaloWidth = null;
            if (arg['text-halo-width'] !== undefined) {
                textHaloWidth = context.parse(arg['text-halo-width'], 1, NumberType);
                if (!textHaloWidth) return null;
            }

            let textHaloBlur = null;
            if (arg['text-halo-blur'] !== undefined) {
                textHaloBlur = context.parse(arg['text-halo-blur'], 1, NumberType);
                if (!textHaloBlur) return null;
            }

            let verticalAlign = null;
            if (arg['vertical-align'] !== undefined) {
                if (typeof arg['vertical-align'] === 'string' && !['bottom', 'center', 'top'].includes(arg['vertical-align'])) {
                    return context.error(`'vertical-align' must be one of: 'bottom', 'center', 'top' but found '${arg['vertical-align']}' instead.`) as null;
                }

                verticalAlign = context.parse(arg['vertical-align'], 1, StringType);
                if (!verticalAlign) return null;
            }

            let textRotationAlignment = null;
            if (arg['text-rotation-alignment'] !== undefined) {
                if (typeof arg['text-rotation-alignment'] === 'string' && !isValidTextRotationAlignment(arg['text-rotation-alignment'])) {
                    return context.error(`'text-rotation-alignment' must be one of: 'map', 'viewport', 'viewport-glyph', 'auto' but found '${arg['text-rotation-alignment']}' instead.`) as null;
                }

                textRotationAlignment = context.parse(arg['text-rotation-alignment'], 1, StringType);
                if (!textRotationAlignment) return null;
            }

            const lastExpression = sections[sections.length - 1];
            lastExpression.scale = scale;
            lastExpression.font = font;
            lastExpression.textColor = textColor;
            lastExpression.textHaloColor = textHaloColor;
            lastExpression.textHaloWidth = textHaloWidth;
            lastExpression.textHaloBlur = textHaloBlur;
            lastExpression.verticalAlign = verticalAlign;
            lastExpression.textRotationAlignment = textRotationAlignment;
        } else {
            const content = context.parse(args[i], 1, ValueType);
            if (!content) return null;

            const kind = content.type.kind;
            if (kind !== 'string' && kind !== 'value' && kind !== 'null' && kind !== 'resolvedImage') {
                return context.error('Formatted text type must be \'string\', \'value\', \'image\' or \'null\'.') as null;
            }

            nextTokenMayBeObject = true;
            sections.push({
                content,
                scale: null,
                font: null,
                textColor: null,
                textHaloColor: null,
                textHaloWidth: null,
                textHaloBlur: null,
                verticalAlign: null,
                textRotationAlignment: null
            });
        }
    }

    return new FormatExpressionClass(sections);
};

FormatExpressionClass.prototype.evaluate = function(ctx: any) {
    const evaluateSection = (section: ExtendedFormattedSectionExpression) => {
        const evaluatedContent = section.content.evaluate(ctx);
        if (typeOf(evaluatedContent) === ResolvedImageType) {
            const formattedSection = new FormattedSection(
                '',
                evaluatedContent,
                null,
                null,
                null,
                section.verticalAlign ? section.verticalAlign.evaluate(ctx) : null
            );
            (formattedSection as any).textHaloColor = null;
            (formattedSection as any).textHaloWidth = null;
            (formattedSection as any).textHaloBlur = null;
            return formattedSection;
        }

        const formattedSection = new FormattedSection(
            valueToString(evaluatedContent),
            null,
            section.scale ? section.scale.evaluate(ctx) : null,
            section.font ? section.font.evaluate(ctx).join(',') : null,
            section.textColor ? section.textColor.evaluate(ctx) : null,
            section.verticalAlign ? section.verticalAlign.evaluate(ctx) : null
        );
        (formattedSection as any).textHaloColor = section.textHaloColor ? section.textHaloColor.evaluate(ctx) : null;
        (formattedSection as any).textHaloWidth = section.textHaloWidth ? section.textHaloWidth.evaluate(ctx) : null;
        (formattedSection as any).textHaloBlur = section.textHaloBlur ? section.textHaloBlur.evaluate(ctx) : null;
        (formattedSection as any).textRotationAlignment = section.textRotationAlignment ? section.textRotationAlignment.evaluate(ctx) : null;
        return formattedSection;
    };

    return new Formatted((this.sections as ExtendedFormattedSectionExpression[]).map(evaluateSection));
};

FormatExpressionClass.prototype.eachChild = function(fn: (_: any) => void) {
    for (const section of this.sections as ExtendedFormattedSectionExpression[]) {
        fn(section.content);
        if (section.scale) {
            fn(section.scale);
        }
        if (section.font) {
            fn(section.font);
        }
        if (section.textColor) {
            fn(section.textColor);
        }
        if (section.textHaloColor) {
            fn(section.textHaloColor);
        }
        if (section.textHaloWidth) {
            fn(section.textHaloWidth);
        }
        if (section.textHaloBlur) {
            fn(section.textHaloBlur);
        }
        if (section.verticalAlign) {
            fn(section.verticalAlign);
        }
        if (section.textRotationAlignment) {
            fn(section.textRotationAlignment);
        }
    }
};
