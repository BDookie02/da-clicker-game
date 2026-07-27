import argparse
import glob
import os
import bpy
import sys


parser = argparse.ArgumentParser()
parser.add_argument('--scene-dir', required=True)
parser.add_argument('--output-dir', required=True)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
scene_dir = os.path.abspath(args.scene_dir)
output_dir = os.path.abspath(args.output_dir)
os.makedirs(output_dir, exist_ok=True)

files = sorted(glob.glob(os.path.join(scene_dir, '*.blend')))
for index, path in enumerate(files, 1):
    bpy.ops.wm.open_mainfile(filepath=path)
    scene = bpy.context.scene
    scene.render.film_transparent = True
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    for obj in scene.objects:
        if obj.type == 'MESH' and not bool(obj.get('cosmetic_asset', False)):
            obj.hide_render = True
    output = os.path.join(output_dir, f'{os.path.splitext(os.path.basename(path))[0]}.png')
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.filepath = output
    bpy.ops.render.render(write_still=True)
    print(f'ISOLATED {index}/{len(files)} {output}')

print(f'COMPLETE {len(files)}/{len(files)} isolated cosmetic renders')
