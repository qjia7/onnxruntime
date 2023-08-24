/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

// sampled from [@tensorflow/tfjs] tfjs-backend-webgpu/src/matmul_packed_webgpu.ts
//
// modified to fit the needs of the project

import {TensorView} from '../../../tensor';
import {ShapeUtil} from '../../../util';
import {GpuDataType, ProgramInfo, ProgramMetadata} from '../../types';
import {getActicationSnippet, InternalActivationAttributes} from '../fuse-utils';

import {biasActivationSnippet, typeSnippet} from './activation_util';

const writeDataToSubAVec4Snippet = (transpose: boolean) => {
  if (transpose) {
    return `
        mm_Asub[inputRow][inputCol] = mm_readA(batch,
          kStart + inputRow,
          globalRowStart / innerElementSize + inputCol);
        `;

  } else {
    return `
        mm_Asub[inputRow][inputCol] = mm_readA(batch,
          globalRow + innerRow,
          kStart / innerElementSize + inputCol);
        `;
  }
};

const calculateResultSnippet = (transposeA: boolean, innerElementSize: number) => {
  if (transposeA) {
    return `
        let ACached0 = mm_Asub[k * innerElementSize][localRow];
        let ACached1 = mm_Asub[k * innerElementSize + 1][localRow];
        let ACached2 = mm_Asub[k * innerElementSize + 2][localRow];
        ${innerElementSize === 3 ? '' : 'let ACached3 = mm_Asub[k * innerElementSize + 3][localRow];'}
        for (var i = 0; i < rowPerThread; i = i + 1) {
          acc[i] = BCached0 * ACached0[i] + acc[i];
          acc[i] = BCached1 * ACached1[i] + acc[i];
          acc[i] = BCached2 * ACached2[i] + acc[i];
          ${innerElementSize === 3 ? '' : 'acc[i] = BCached3 * ACached3[i] + acc[i];'}
        }`;
  } else {
    return `
        for (var i = 0; i < rowPerThread; i = i + 1) {
          let ACached = mm_Asub[tileRow + i][k];
          acc[i] = BCached0 * ACached.x + acc[i];
          acc[i] = BCached1 * ACached.y + acc[i];
          acc[i] = BCached2 * ACached.z + acc[i];
          ${innerElementSize === 3 ? '' : 'acc[i] = BCached3 * ACached.w + acc[i];'}
        }`;
  }
};

export const makeMatMulPackedVec4Source =
    (workPerThread: number[], workgroupSize: [number, number, number], transposeA = false, tileInner = 32,
     splitK = false, splitedDimInner = 32, isVectorA = false): string => {
      const tileAOuter = workgroupSize[1] * workPerThread[1];
      const tileBOuter = workgroupSize[0] * workPerThread[0];
      const tileAWidth = transposeA ? tileAOuter : tileInner;
      const tileAHight = transposeA ? tileInner : tileAOuter;
      const innerElementSize = tileAWidth / workgroupSize[0];
      const rowPerThreadB = tileInner / workgroupSize[1];

      if (!(((transposeA && innerElementSize === 4 && workPerThread[1] === 4) ||
             (!transposeA && (innerElementSize === 3 || innerElementSize === 4))) &&
            tileAWidth % workgroupSize[0] === 0 && tileInner % workgroupSize[1] === 0 && workPerThread[0] === 4)) {
        throw new Error(`If transposeA ${transposeA} is true, innerElementSize ${
            innerElementSize} and workPerThread[1] ${workPerThread[1]} must be 4.
      Otherwise, innerElementSize ${innerElementSize} must be 3 or 4.
  tileAWidth ${tileAWidth} must be divisible by workgroupSize[0]${workgroupSize[0]}. tileInner ${
            tileInner} must be divisible by workgroupSize[1] ${workgroupSize[1]}. colPerThread ${
            workPerThread[0]} must be 4.`);
      }
      return `
var<workgroup> mm_Asub : array<array<vec${innerElementSize}<f32>, ${tileAWidth / innerElementSize}>, ${tileAHight}>;
var<workgroup> mm_Bsub : array<array<vec4<f32>, ${tileBOuter / workPerThread[0]}>, ${tileInner}>;

const rowPerThread = ${workPerThread[1]};
const colPerThread = ${workPerThread[0]};
const innerElementSize = ${innerElementSize};
const tileInner = ${tileInner};

@compute @workgroup_size(${workgroupSize[0]}, ${workgroupSize[1]}, ${workgroupSize[2]})
fn main(@builtin(local_invocation_id) localId : vec3<u32>,
        @builtin(global_invocation_id) globalId : vec3<u32>,
        @builtin(workgroup_id) workgroupId : vec3<u32>) {
  let localRow = i32(localId.y);
  let tileRow = ${isVectorA ? '0' : 'localRow * rowPerThread'};
  let tileCol = i32(localId.x);

  let globalRow = ${isVectorA ? '0' : 'i32(globalId.y) * rowPerThread'};
  let globalCol = i32(globalId.x);
  let batch = ${splitK ? '0' : 'i32(globalId.z)'};
  let globalRowStart = i32(workgroupId.y) * ${tileAOuter};

  let numTiles = ${splitK ? `${Math.ceil(splitedDimInner / tileInner)}` : '(dimInner - 1) / tileInner + 1'};
  var kStart = ${splitK ? `i32(globalId.z) * ${splitedDimInner}` : '0'};

  var acc: array<vec4<f32>, rowPerThread>;

  // Loop over shared dimension.
  let tileRowB = localRow * ${rowPerThreadB};
  for (var t = 0; t < numTiles; t = t + 1) {
      // Load one tile of A into local memory.
      for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
          let inputRow = tileRow + innerRow;
          let inputCol = tileCol;
          ${writeDataToSubAVec4Snippet(transposeA)}
      }

      // Load one tile of B into local memory.
      for (var innerRow = 0; innerRow < ${rowPerThreadB}; innerRow = innerRow + 1) {
          let inputRow = tileRowB + innerRow;
          let inputCol = tileCol;
          mm_Bsub[inputRow][inputCol] = mm_readB(batch, kStart + inputRow, globalCol);
      }
      kStart = kStart + tileInner;
      workgroupBarrier();

      // Compute acc values for a single thread.
      for (var k = 0; k < tileInner / innerElementSize; k = k + 1) {
          let BCached0 = mm_Bsub[k * innerElementSize][tileCol];
          let BCached1 = mm_Bsub[k * innerElementSize + 1][tileCol];
          let BCached2 = mm_Bsub[k * innerElementSize + 2][tileCol];
          ${innerElementSize === 3 ? '' : 'let BCached3 = mm_Bsub[k * innerElementSize + 3][tileCol];'}

          ${calculateResultSnippet(transposeA, innerElementSize)}
      }

      workgroupBarrier();
  }

  for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
      mm_write(batch, globalRow + innerRow, globalCol, acc[innerRow]);
  }
}`;
    };

const writeDataToSubASnippet = (transpose: boolean) => {
  if (transpose) {
    return `
            mm_Asub[inputRow][inputCol] = mm_readA(batch,
              kStart + inputRow,
              globalRowStart + inputCol);
            `;

  } else {
    return `
            mm_Asub[inputRow][inputCol] = mm_readA(batch,
              globalRowStart + inputRow,
              kStart + inputCol);
            `;
  }
};

const readDataFromSubASnippet = (transposeA: boolean) =>
    transposeA ? 'let ACached = mm_Asub[k][tileRow + innerRow];' : 'let ACached = mm_Asub[tileRow + innerRow][k];';

// sequentialAccessByThreads means sequential data in memory is accessed by
// threads, instead of a single thread (default behavior).
export const makeMatMulPackedSource =
    (workPerThread: number[], workgroupSize: [number, number, number], transposeA = false, tileInner = 32,
     splitK = false, splitedDimInner = 32, sequentialAccessByThreads = false): string => {
      const tileAOuter = workPerThread[1] * workgroupSize[1];
      const tileBOuter = workPerThread[0] * workgroupSize[0];
      const tileAWidth = transposeA ? tileAOuter : tileInner;
      const tileAHight = transposeA ? tileInner : tileAOuter;

      if (!(tileAHight % workgroupSize[1] === 0 && tileAWidth % workgroupSize[0] === 0 &&
            tileInner % workgroupSize[1] === 0)) {
        throw new Error(`tileAHight ${tileAHight} must be divisible by workgroupSize[1]${
            workgroupSize[1]}, tileAWidth ${tileAWidth} must be divisible by workgroupSize[0]${
            workgroupSize[0]}, tileInner ${tileInner} must be divisible by workgroupSize[1]${workgroupSize[1]}`);
      }
      const rowPerThreadA = tileAHight / workgroupSize[1];
      const colPerThreadA = tileAWidth / workgroupSize[0];
      const rowPerThreadB = tileInner / workgroupSize[1];
      const matmulSnippet = sequentialAccessByThreads ?
          `
    let localRow = i32(localId.y);
    let localCol = i32(localId.x);
    let globalRowStart = i32(workgroupId.y) * ${tileAOuter};
    let globalColStart = i32(workgroupId.x) * ${tileBOuter};

    // Loop over shared dimension.
    for (var t = 0; t < numTiles; t = t + 1) {
      // Load one tile of A into local memory.
      for (var inputRow = localRow; inputRow < ${tileAHight}; inputRow = inputRow + ${workgroupSize[1]}) {
        for (var inputCol = localCol; inputCol < ${tileAWidth}; inputCol = inputCol + ${workgroupSize[0]}) {
          ${writeDataToSubASnippet(transposeA)}
        }
      }
      // Load one tile of B into local memory.
      for (var inputRow = localRow; inputRow < ${tileInner}; inputRow = inputRow + ${workgroupSize[1]}) {
            for (var inputCol = localCol; inputCol < ${tileBOuter}; inputCol = inputCol + ${workgroupSize[0]}) {
          mm_Bsub[inputRow][inputCol] = mm_readB(batch,
            kStart + inputRow,
            globalColStart + inputCol);
        }
      }
      kStart = kStart + tileInner;
      workgroupBarrier();

      // Compute acc values for a single thread.
      var BCached : array<f32, colPerThread>;
      for (var k = 0; k < tileInner; k = k + 1) {
        for (var inner = 0; inner < colPerThread; inner = inner + 1) {
          BCached[inner] = mm_Bsub[k][localCol + inner * ${workgroupSize[0]}];
        }
        for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
          let ACached = ${
              transposeA ? `mm_Asub[k][localRow + innerRow * ${workgroupSize[1]}];` :
                           `mm_Asub[localRow + innerRow * ${workgroupSize[1]}][k];`}
          for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
            acc[innerRow][innerCol] = acc[innerRow][innerCol] +
                ACached * BCached[innerCol];
          }
        }
      }
      workgroupBarrier();
    }
    for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
      let gRow = globalRowStart + localRow + innerRow * ${workgroupSize[1]};
      for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
        let gCol = globalColStart + localCol + innerCol * ${workgroupSize[0]};
        mm_write(batch, gRow, gCol, acc[innerRow][innerCol]);
      }
    }
    ` :
          `
let tileRow = i32(localId.y) * rowPerThread;
let tileCol = i32(localId.x) * colPerThread;

let globalRow = i32(globalId.y) * rowPerThread;
let globalCol = i32(globalId.x) * colPerThread;
let globalRowStart = i32(workgroupId.y) * ${tileAOuter};

let tileRowA = i32(localId.y) * ${rowPerThreadA};
let tileColA = i32(localId.x) * ${colPerThreadA};
let tileRowB = i32(localId.y) * ${rowPerThreadB};
// Loop over shared dimension.
for (var t = 0; t < numTiles; t = t + 1) {
  // Load one tile of A into local memory.
  for (var innerRow = 0; innerRow < ${rowPerThreadA}; innerRow = innerRow + 1) {
    for (var innerCol = 0; innerCol < ${colPerThreadA}; innerCol = innerCol + 1) {
      let inputRow = tileRowA + innerRow;
      let inputCol = tileColA + innerCol;
      ${writeDataToSubASnippet(transposeA)}
    }
  }

  // Load one tile of B into local memory.
  for (var innerRow = 0; innerRow < ${rowPerThreadB}; innerRow = innerRow + 1) {
    for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
      let inputRow = tileRowB + innerRow;
      let inputCol = tileCol + innerCol;
      mm_Bsub[inputRow][inputCol] = mm_readB(batch,
        kStart + inputRow,
        globalCol + innerCol);
    }
  }
  kStart = kStart + tileInner;
  workgroupBarrier();

  // Compute acc values for a single thread.
  var BCached : array<f32, colPerThread>;
  for (var k = 0; k < tileInner; k = k + 1) {
    for (var inner = 0; inner < colPerThread; inner = inner + 1) {
      BCached[inner] = mm_Bsub[k][tileCol + inner];
    }

    for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
      ${readDataFromSubASnippet(transposeA)}
      for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
        acc[innerRow][innerCol] = acc[innerRow][innerCol] + ACached * BCached[innerCol];
      }
    }
  }

  workgroupBarrier();
}

for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
  for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
    mm_write(batch, globalRow + innerRow, globalCol + innerCol,
        acc[innerRow][innerCol]);
  }
}
`;

      return `
  var<workgroup> mm_Asub : array<array<f32, ${tileAWidth}>, ${tileAHight}>;
  var<workgroup> mm_Bsub : array<array<f32, ${tileBOuter}>, ${tileInner}>;
  const rowPerThread = ${workPerThread[1]};
  const colPerThread = ${workPerThread[0]};
  const tileInner = ${tileInner};

@compute @workgroup_size(${workgroupSize[0]}, ${workgroupSize[1]}, ${workgroupSize[2]})
fn main(@builtin(local_invocation_id) localId : vec3<u32>,
        @builtin(global_invocation_id) globalId : vec3<u32>,
        @builtin(workgroup_id) workgroupId : vec3<u32>) {
    let batch = ${splitK ? '0' : 'i32(globalId.z)'};
    let numTiles = ${splitK ? `${Math.ceil(splitedDimInner / tileInner)}` : '(dimInner - 1) / tileInner + 1'};
    var kStart = ${splitK ? `i32(globalId.z) * ${splitedDimInner}` : '0'};

    var acc : array<array<f32, colPerThread>, rowPerThread>;

    // Without this initialization strange values show up in acc.
    for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
      for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
        acc[innerRow][innerCol] = 0.0;
      }
    }
    ${matmulSnippet}
  }
`;
    };

const matMulReadWriteFnSource =
    (component: number, hasBias: boolean, transposeB = false, applyActivation: string): string => {
      const source = `
    fn getIndexFromCoords3D(coords : vec3<i32>, shape : vec3<i32>) -> i32 {
      return dot(coords, vec3<i32>(shape.y * shape.z, shape.z, 1));
    }

    fn mm_readA(batch: i32, row: i32, colIn: i32) -> ${typeSnippet(component)} {
      var value = ${typeSnippet(component)}(0.0);
      let col = colIn * ${component};
      if(row < dimAOuter && col < dimInner)
      {
        let coords = vec3<i32>(batch, row, col);
        let aIndex = getIndexFromCoords3D(coords, aShape) / ${component};
        value = a[aIndex];
      }
      return value;
    }

    fn mm_readB(batch: i32, row: i32, colIn: i32) -> ${typeSnippet(component)} {
      var value = ${typeSnippet(component)}(0.0);
      let col = colIn * ${component};
      if(row < dimInner && col < dimBOuter)
      {
        let coords = ${transposeB ? 'vec3<i32>(batch, col, row)' : 'vec3<i32>(batch, row, col)'};
        let bIndex = getIndexFromCoords3D(coords, bShape) / ${component};
        value = b[bIndex];
      }
      return value;
    }

    fn mm_write(batch: i32, row: i32, colIn: i32, valueIn: ${typeSnippet(component)}) {
      let col = colIn * ${component};
      if (row < dimAOuter && col < dimBOuter) {
        var value = valueIn;
        let coords = vec3<i32>(batch, row, col);
        ${biasActivationSnippet(hasBias)}
        ${applyActivation}
        let outIndex = getIndexFromCoords3D(coords, outShape) / ${component};
        output[outIndex] = value;
      }
    }
    `;
      return source;
    };

export const createMatmulProgramInfo =
    (metadata: ProgramMetadata, inputs: readonly TensorView[], activationAttributes: InternalActivationAttributes,
     outputShape: readonly number[], transposeB = false): ProgramInfo => {
      const aShape = inputs[0].dims;
      const bShape = inputs[1].dims;

      const outerDimsA = aShape.slice(0, -2);
      const outerDimsB = bShape.slice(0, -2);
      const outerDims = outputShape.slice(0, -2);
      const batchSize = ShapeUtil.size(outerDims);
      const batchSizeA = ShapeUtil.size(outerDimsA);
      const batchSizeB = ShapeUtil.size(outerDimsB);
      // TODO: support broadcasting

      const dimAOuter = outputShape[outputShape.length - 2];
      const dimInner = aShape[aShape.length - 1];
      const dimBOuter = outputShape[outputShape.length - 1];
      const b3DShape = transposeB ? [batchSizeB, dimBOuter, dimInner] : [batchSizeB, dimInner, dimBOuter];
      const isVec4 = dimInner % 4 === 0 && dimBOuter % 4 === 0;
      const dataType = isVec4 ? 'vec4<f32>' : 'f32';  // TODO: support other data type
      const component = isVec4 ? 4 : 1;
      const {activationFunction, applyActivation} = getActicationSnippet(activationAttributes);

      // TODO: fine tune size
      const elementsPerThread = dimAOuter <= 8 ? [4, 1, 1] : [4, 4, 1];
      const workgroupSize: [number, number, number] = [8, 8, 1];
      const dispatch = [
        Math.ceil(dimBOuter / workgroupSize[0] / elementsPerThread[0]),
        Math.ceil(dimAOuter / workgroupSize[1] / elementsPerThread[1]),
        Math.ceil(batchSize / workgroupSize[2] / elementsPerThread[2])
      ];

      const declareInputs = [
        `@group(0) @binding(0) var<storage, read> a: array<${dataType}>;`,
        `@group(0) @binding(1) var<storage, read> b: array<${dataType}>;`
      ];
      const hasBias = inputs.length > 2;
      let declareFunctions = matMulReadWriteFnSource(component, hasBias, transposeB, applyActivation);
      if (hasBias) {
        declareInputs.push(`@group(0) @binding(2) var<storage, read> bias: array<${dataType}>;`);
        declareFunctions += `
            fn getBiasByOutputCoords(coords : vec3<i32>) -> ${dataType} {
              return bias[coords.z / ${component}];
            }`;
      }
      const getShaderSource = () => `
  const dimAOuter: i32 = ${dimAOuter};
  const dimBOuter: i32 = ${dimBOuter};
  const dimInner: i32 = ${dimInner};
  const aShape : vec3<i32> = vec3<i32>(${batchSizeA}, ${dimAOuter}, ${dimInner});
  const bShape : vec3<i32> = vec3<i32>(${b3DShape.join(',')});
  const outShape : vec3<i32> = vec3<i32>(${batchSize}, ${dimAOuter}, ${dimBOuter});
  ${declareInputs.join('')}
  @group(0) @binding(${declareInputs.length}) var<storage, read_write> output : array<${dataType}>;
  ${declareFunctions}
  ${activationFunction}
  ${
          isVec4 ? makeMatMulPackedVec4Source(elementsPerThread, workgroupSize) :
                   makeMatMulPackedSource(elementsPerThread, workgroupSize)}`;
      return {
        ...metadata,
        outputs: [{dims: outputShape, dataType: inputs[0].dataType, gpuDataType: GpuDataType.default}],
        getShaderSource,
        dispatchGroup: () => ({x: dispatch[0], y: dispatch[1], z: dispatch[2]})
      };
    };
