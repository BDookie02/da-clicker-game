import argparse
import bpy
import os
import sys


parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)

scene = bpy.context.scene
scene.render.film_transparent = True
scene.render.resolution_x = 640
scene.render.resolution_y = 640
scene.render.resolution_percentage = 100

# Keep camera and lighting, but render only objects explicitly exported as the
# cosmetic. The resulting alpha is used to pixelate the asset without touching
# its preview environment.
for obj in scene.objects:
    if obj.type == 'MESH' and not bool(obj.get('cosmetic_asset', False)):
        obj.hide_render = True

scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.filepath = args.output
bpy.ops.render.render(write_still=True)
print(f'ISOLATED_RENDER {args.output}')
